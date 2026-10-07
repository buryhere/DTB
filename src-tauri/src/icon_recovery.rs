//! Write-ahead ownership journal. Recovery only touches an icon if its current
//! position still matches our last confirmed or interrupted pending write.
use crate::{board_store::atomic_write, icon_engine::desktop};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use windows::Win32::{
    Foundation::{CloseHandle, WAIT_TIMEOUT},
    System::{
        Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    },
    UI::WindowsAndMessaging::{IsWindowVisible, ShowWindowAsync, SW_SHOWNA},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub home: Point,
    pub last: Point,
    pub pending: Option<Point>,
}
impl Entry {
    pub fn owns(&self, p: Point) -> bool {
        self.last == p || self.pending == Some(p)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Journal {
    pub version: u32,
    pub pid: u32,
    pub token: String,
    pub hidden: bool,
    pub was_visible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<crate::desktop_clip::ClipLease>,
    pub entries: BTreeMap<String, Entry>,
}
impl Journal {
    pub fn new() -> Self {
        Self {
            version: 1,
            pid: std::process::id(),
            token: format!("{}-{}", std::process::id(), now()),
            hidden: false,
            was_visible: false,
            clip: None,
            entries: BTreeMap::new(),
        }
    }
    pub fn write(&self, root: &Path) -> Result<(), String> {
        atomic_write(
            &root.join("icon-recovery.json"),
            &serde_json::to_vec(self).map_err(|e| e.to_string())?,
        )
    }
    pub fn load(root: &Path) -> Result<Option<Self>, String> {
        let path = root.join("icon-recovery.json");
        if !path.exists() {
            return Ok(None);
        }
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let j: Self = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if j.version != 1 {
            return Err("图标恢复记录版本无效".into());
        }
        Ok(Some(j))
    }
}
pub fn now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
pub fn alive(pid: u32) -> bool {
    unsafe {
        match OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            Ok(h) => {
                let live = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
                let _ = CloseHandle(h);
                live
            }
            Err(_) => false,
        }
    }
}
pub fn points(snapshot: &serde_json::Value) -> BTreeMap<String, Point> {
    snapshot["icons"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|i| {
            Some((
                i["id"].as_str()?.to_owned(),
                Point {
                    x: i["x"].as_i64()? as i32,
                    y: i["y"].as_i64()? as i32,
                },
            ))
        })
        .collect()
}

// Caller owns a COM STA. Show the real desktop even when a position write fails.
pub unsafe fn recover(root: &Path, token: Option<&str>) -> Result<usize, String> {
    let Some(mut j) = Journal::load(root)? else {
        return Ok(0);
    };
    if token.is_some_and(|t| t != j.token) {
        return Ok(0);
    }
    if let Some(clip) = &j.clip {
        clip.clear()?;
    }
    j.clip = None;
    if j.hidden && j.was_visible {
        let hwnd = desktop::def_view();
        if !hwnd.0.is_null() {
            let _ = ShowWindowAsync(hwnd, SW_SHOWNA);
        }
    }
    let snapshot = desktop::read()?;
    let current = points(&snapshot);
    let targets: BTreeMap<_, _> = j
        .entries
        .iter()
        .filter_map(|(id, e)| {
            current
                .get(id)
                .filter(|p| e.owns(**p))
                .map(|_| (id.clone(), e.home))
        })
        .collect();
    if snapshot["autoArrange"] == true {
        // Automatic arrangement is owned by Explorer/the user; never undo it.
        j.entries.clear();
        j.hidden = false;
        j.write(root)?;
        return Ok(0);
    }
    desktop::position(&targets)?;
    let after = points(&desktop::read()?);
    // Keep any failed writes for another recovery attempt.
    j.entries
        .retain(|id, e| after.get(id).is_some_and(|p| e.owns(*p) && *p != e.home));
    j.hidden = false;
    j.write(root)?;
    if !j.entries.is_empty() {
        return Err("部分图标位置尚未恢复，已保留恢复记录。".into());
    }
    Ok(targets.len())
}

pub struct Guard {
    pub token: String,
    pub pid: u32,
    root: PathBuf,
}
impl Guard {
    pub fn launch(root: &Path, journal: &Journal) -> Result<Self, String> {
        use std::os::windows::process::CommandExt;
        journal.write(root)?;
        let mut guard = Self {
            token: journal.token.clone(),
            pid: 0,
            root: root.to_owned(),
        };
        guard.pulse()?;
        let child = std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
            .args(["--icon-guard", "--root"])
            .arg(root)
            .args([
                "--token",
                &journal.token,
                "--parent-pid",
                &journal.pid.to_string(),
            ])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("无法启动图标恢复进程：{e}"))?;
        guard.pid = child.id();
        let ready = root.join("icon-guard.ready");
        for _ in 0..100 {
            if std::fs::read_to_string(&ready).ok().as_deref() == Some(&journal.token)
                && alive(guard.pid)
            {
                return Ok(guard);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err("图标恢复进程未就绪；本次不改变桌面图标。".into())
    }
    pub fn pulse(&self) -> Result<(), String> {
        atomic_write(
            &self.root.join("icon-lease.json"),
            &serde_json::to_vec(&serde_json::json!({"token":self.token,"time":now()}))
                .map_err(|e| e.to_string())?,
        )
    }
}

// Runs before Tauri/single-instance startup, so the guard survives the UI host.
pub fn cli() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    let is_guard = args.iter().any(|a| a == "--icon-guard");
    let is_recover = args.iter().any(|a| a == "--restore-desktop-icons");
    if !is_guard && !is_recover {
        return false;
    }
    let arg = |key: &str| {
        args.iter()
            .position(|a| a == key)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let Some(root) = arg("--root").map(PathBuf::from) else {
        return true;
    };
    let token = arg("--token")
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let pid = arg("--parent-pid")
        .and_then(|s| s.to_string_lossy().parse::<u32>().ok())
        .unwrap_or(0);
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return true;
        }
        if is_recover {
            if let Ok(Some(j)) = Journal::load(&root) {
                if !alive(j.pid) {
                    let _ = recover(&root, None);
                }
            }
            CoUninitialize();
            return true;
        }
        if Journal::load(&root)
            .ok()
            .flatten()
            .is_some_and(|j| j.token == token && j.pid == pid)
        {
            let _ = atomic_write(&root.join("icon-guard.ready"), token.as_bytes());
            loop {
                let Ok(Some(j)) = Journal::load(&root) else {
                    break;
                };
                if j.token != token {
                    break;
                }
                let expired = std::fs::read(root.join("icon-lease.json"))
                    .ok()
                    .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                    .is_none_or(|v| {
                        v["token"] != token
                            || now().saturating_sub(v["time"].as_u64().unwrap_or(0) as u128) > 4000
                    });
                if !alive(pid) || expired {
                    // Block further writes before recovering a hung host.
                    let _ = atomic_write(&root.join("icon-guard.revoked"), token.as_bytes());
                    for _ in 0..10 {
                        if recover(&root, Some(&token)).is_ok() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(500));
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        CoUninitialize();
    }
    true
}

pub unsafe fn desktop_visible() -> bool {
    IsWindowVisible(desktop::def_view()).as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_respects_manual_moves_and_interrupted_commit() {
        let e = Entry {
            home: Point { x: 0, y: 0 },
            last: Point { x: 100, y: 0 },
            pending: Some(Point { x: 200, y: 0 }),
        };
        assert!(e.owns(Point { x: 100, y: 0 }));
        assert!(e.owns(Point { x: 200, y: 0 }));
        assert!(!e.owns(Point { x: 150, y: 0 }));
    }
    #[test]
    fn journal_roundtrip_keeps_identity_and_coordinates() {
        let mut j = Journal::new();
        j.entries.insert(
            "serialized-pidl".into(),
            Entry {
                home: Point { x: -1280, y: 122 },
                last: Point { x: 20, y: 122 },
                pending: None,
            },
        );
        let copy: Journal = serde_json::from_slice(&serde_json::to_vec(&j).unwrap()).unwrap();
        assert_eq!(copy.entries["serialized-pidl"].home.x, -1280);
        assert_eq!(copy.token, j.token);
    }
    #[test]
    fn previous_journals_without_clipping_remain_readable() {
        let bytes = br#"{"version":1,"pid":123,"token":"old","hidden":true,"was_visible":true,"entries":{}}"#;
        let journal: Journal = serde_json::from_slice(bytes).unwrap();
        assert!(journal.clip.is_none());
        assert!(journal.hidden && journal.was_visible);
    }
}
