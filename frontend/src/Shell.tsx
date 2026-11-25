import { Link, Navigate, Route, Routes } from 'react-router'
import type { SessionUser } from './api'
import AplicarCredito from './screens/AplicarCredito'
import AResolver from './screens/AResolver'
import DocumentForm from './screens/DocumentForm'
import Documento from './screens/Documento'
import MarcarPagado from './screens/MarcarPagado'
import PagoRegistrado from './screens/PagoRegistrado'
import Pagos from './screens/Pagos'
import Proveedor from './screens/Proveedor'
import RegistrarPago from './screens/RegistrarPago'
import Resumen from './screens/Resumen'
import Subidas from './screens/Subidas'
import Subir from './screens/Subir'
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
        <nav className="shell-nav">
          <Link to="/">Resumen</Link>
          <Link to="/a-resolver">A resolver</Link>
          <Link to="/subir">Subir</Link>
          <Link to="/subidas">Subidas</Link>
          <Link to="/pagos">Pagos</Link>
        </nav>
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
          <Route path="/proveedores/:id/aplicar-credito" element={<AplicarCredito />} />
          <Route path="/proveedores/:id/documentos/:documentId/marcar-pagado" element={<MarcarPagado />} />
          <Route path="/a-resolver" element={<AResolver />} />
          <Route path="/subir" element={<Subir />} />
          <Route path="/subidas" element={<Subidas />} />
          <Route path="/documentos/:id" element={<Documento />} />
          <Route path="/pagos" element={<Pagos />} />
          <Route path="/pagos/nuevo" element={<RegistrarPago />} />
          <Route path="/pagos/:id" element={<PagoRegistrado />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  )
}

export default Shell
