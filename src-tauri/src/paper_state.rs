use serde_json::{json, Value};

// The text/file items mirror the continuous editor at paper coordinates. After
// topology changes rebuild editable rows from that mirror, never clone stale rows.
pub fn rebuild_rows(board: &mut Value) {
    board.as_object_mut().unwrap().remove("paperRows");
}

pub fn split_ink(board: &Value, direction: &str, coordinate: f64) -> (Value, Value) {
    let mut first = Vec::new();
    let mut second = Vec::new();
    for stroke in board["ink"].as_array().into_iter().flatten() {
        for (upper, list) in [(true, &mut first), (false, &mut second)] {
            let points = stroke["points"].as_array().cloned().unwrap_or_default();
            let mut pieces: Vec<Vec<Value>> = Vec::new();
            let mut current = Vec::new();
            for pair in points.windows(2) {
                let a = &pair[0];
                let b = &pair[1];
                let axis = if direction == "horizontal" { "y" } else { "x" };
                let av = a[axis].as_f64().unwrap_or(0.0);
                let bv = b[axis].as_f64().unwrap_or(0.0);
                let inside = |v: f64| {
                    if upper {
                        v <= coordinate
                    } else {
                        v >= coordinate
                    }
                };
                let mut aa = a.clone();
                let mut bb = b.clone();
                if !inside(av) && !inside(bv) {
                    if !current.is_empty() {
                        pieces.push(std::mem::take(&mut current));
                    }
                    continue;
                }
                if inside(av) != inside(bv) {
                    let t = (coordinate - av) / (bv - av);
                    let cut = json!({"x":a["x"].as_f64().unwrap_or(0.0)+(b["x"].as_f64().unwrap_or(0.0)-a["x"].as_f64().unwrap_or(0.0))*t,"y":a["y"].as_f64().unwrap_or(0.0)+(b["y"].as_f64().unwrap_or(0.0)-a["y"].as_f64().unwrap_or(0.0))*t});
                    if !inside(av) {
                        aa = cut;
                    } else {
                        bb = cut;
                    }
                }
                for mut p in [aa, bb] {
                    if !upper {
                        p[axis] = json!(p[axis].as_f64().unwrap_or(0.0) - coordinate);
                    }
                    if current.last() != Some(&p) {
                        current.push(p);
                    }
                }
                if !inside(bv) {
                    pieces.push(std::mem::take(&mut current));
                }
            }
            if !current.is_empty() {
                pieces.push(current);
            }
            for (index, points) in pieces.into_iter().enumerate() {
                if points.len() < 2 {
                    continue;
                }
                let mut s = stroke.clone();
                s["id"] = json!(format!(
                    "{}-{}-{index}",
                    stroke["id"].as_str().unwrap_or("ink"),
                    if upper { "a" } else { "b" }
                ));
                s["points"] = json!(points);
                list.push(s);
            }
        }
    }
    (json!(first), json!(second))
}
#[cfg(test)]
pub fn merged_ink(
    target: &Value,
    source: &Value,
    offset: f64,
    vertical: bool,
    scale: f64,
) -> Value {
    let mut result = target["ink"].as_array().cloned().unwrap_or_default();
    for s in source["ink"].as_array().into_iter().flatten() {
        let mut s = s.clone();
        if let Some(points) = s["points"].as_array_mut() {
            for p in points {
                let x = p["x"].as_f64().unwrap_or(0.0);
                let y = p["y"].as_f64().unwrap_or(0.0) * scale;
                p["x"] = json!(x + if vertical { offset } else { 0.0 });
                p["y"] = json!(y + if vertical { 0.0 } else { offset });
            }
        }
        result.push(s);
    }
    json!(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drawing_crossing_cut_survives_both_halves_and_merge() {
        let b = json!({"ink":[{"id":"s","points":[{"x":20,"y":80},{"x":40,"y":140}]}]});
        let (a, c) = split_ink(&b, "horizontal", 100.0);
        assert_eq!(a[0]["points"][1]["y"], 100.0);
        assert_eq!(c[0]["points"][0]["y"], 0.0);
        let merged = merged_ink(&json!({"ink":a}), &json!({"ink":c}), 100.0, false, 1.0);
        assert_eq!(merged[1]["points"][1]["y"], 140.0);
    }
}
