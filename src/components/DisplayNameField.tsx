import type { InputHTMLAttributes } from "react";
import { switchKeyboardLanguage } from "../services/inputLanguage";

interface DisplayNameFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
}

/** A composition-safe, bidirectional display-name field for Arabic and Latin text. */
export function DisplayNameField({
  label,
  value,
  onValueChange,
  maxLength = 60,
  ...inputProps
}: DisplayNameFieldProps) {
  return (
    <label className="multilingual-name-field">
      {label}
      <span className="multilingual-name-input">
        <input
          {...inputProps}
          dir="auto"
          value={value}
          maxLength={maxLength}
          onChange={(event) => onValueChange(event.currentTarget.value)}
        />
        <button
          type="button"
          className="keyboard-language-button"
          title="Switch keyboard language"
          aria-label="Switch keyboard language"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void switchKeyboardLanguage()}
        >
          ع / A
        </button>
      </span>
      <small className="multilingual-name-help">يدعم الأسماء العربية والإنجليزية</small>
    </label>
  );
}

