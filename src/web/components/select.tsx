// Select component for settings forms
import type { ReactElement, SelectHTMLAttributes } from "react"

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: { label: string; value: string }[]
}

export function Select({ options, className, ...props }: SelectProps): ReactElement {
  return (
    <div className="select-wrapper">
      <select className={`settings-select ${className || ""}`} {...props}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <div className="select-icon" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <title>Open options</title>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
    </div>
  )
}
