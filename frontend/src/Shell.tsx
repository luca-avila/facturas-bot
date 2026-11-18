import { Link, Navigate, Route, Routes } from 'react-router'
import type { SessionUser } from './api'
import DocumentForm from './screens/DocumentForm'
import Proveedor from './screens/Proveedor'
import Resumen from './screens/Resumen'
import SupplierForm from './screens/SupplierForm'

interface Props {
  user: SessionUser
  onSignOut: () => void
}

function Shell({ user, onSignOut }: Props) {
  return (
    <>
      <header className="shell-header">
        <Link to="/" className="brand">
          Facturas
        </Link>
        <span className="user-name">{user.name}</span>
        <button type="button" className="secondary" onClick={onSignOut}>
          Cerrar sesión
        </button>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Resumen />} />
          <Route path="/proveedores/nuevo" element={<SupplierForm />} />
          <Route path="/proveedores/:id" element={<Proveedor />} />
          <Route path="/proveedores/:id/editar" element={<SupplierForm />} />
          <Route path="/proveedores/:id/cargar" element={<DocumentForm />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  )
}

export default Shell
