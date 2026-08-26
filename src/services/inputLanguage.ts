import { invoke } from "@tauri-apps/api/core";

export function switchKeyboardLanguage() {
  return invoke<void>("switch_input_language");
}

export function isKeyboardLanguageShortcut(event: KeyboardEvent) {
  return (
    (event.altKey && (event.code === "ShiftLeft" || event.code === "ShiftRight")) ||
    (event.shiftKey && (event.code === "AltLeft" || event.code === "AltRight"))
  );
}

