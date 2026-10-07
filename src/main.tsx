import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import CollisionOverlay from './collision-overlay';
import CutOverlay from './cut-overlay';

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).get('overlay') === 'icons' ? <CollisionOverlay /> : new URLSearchParams(location.search).get('overlay') === 'cut' ? <CutOverlay /> : <App />}
  </React.StrictMode>,
);
