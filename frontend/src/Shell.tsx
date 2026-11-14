import type { SessionUser } from './api'

interface Props {
  user: SessionUser
  onSignOut: () => void
}

function Shell({ user, onSignOut }: Props) {
  return (
    <>
      <header className="shell-header">
        <span className="brand">Facturas</span>
        <span className="user-name">{user.name}</span>
        <button type="button" className="secondary" onClick={onSignOut}>
          Cerrar sesión
        </button>
      </header>
      <main />
    </>
  )
}

export default Shell
