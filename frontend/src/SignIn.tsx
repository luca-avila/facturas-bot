import { useState, type FormEvent } from 'react'
import { signIn, type SessionUser, type SignInError } from './api'

const ERROR_MESSAGES: Record<SignInError, string> = {
  invalid_credentials: 'El email o la contraseña no son correctos.',
  rate_limited: 'Demasiados intentos fallidos. Esperá unos minutos y volvé a intentar.',
  unavailable: 'No se pudo conectar con el servidor. Volvé a intentar.',
}

interface Props {
  onSignedIn: (user: SessionUser) => void
}

function SignIn({ onSignedIn }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<SignInError | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    const result = await signIn(email, password)
    setSubmitting(false)
    if (result.ok) onSignedIn(result.user)
    else setError(result.error)
  }

  return (
    <main className="sign-in">
      <h1>Iniciar sesión</h1>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <p role="alert" className="error">
          {error ? ERROR_MESSAGES[error] : ''}
        </p>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  )
}

export default SignIn
