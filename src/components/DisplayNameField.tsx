import type { InputHTMLAttributes } from "react";

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
      <input
        {...inputProps}
        dir="auto"
        value={value}
        maxLength={maxLength}
        onChange={(event) => onValueChange(event.currentTarget.value)}
      />
      <small className="multilingual-name-help">يدعم الأسماء العربية والإنجليزية</small>
    </label>
  );
}
