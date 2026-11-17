import type { ReactNode } from 'react'

interface Props {
  /** The id of the control in `children`. */
  id: string
  label: ReactNode
  children: ReactNode
  error?: string
}

/** A label, its control and anything after it, then the field's error. Only the label names the control. */
function Field({ id, label, children, error }: Props) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error && <span className="field-error">{error}</span>}
    </div>
  )
}

export default Field
