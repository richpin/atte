/* @refresh reload */
import { render } from "solid-js/web";
import App from "./app/App";
import { initializeTheme } from "./shared/theme";

initializeTheme();
render(() => <App />, document.getElementById("root") as HTMLElement);
