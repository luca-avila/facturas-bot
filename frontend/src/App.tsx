import { useEffect, useState } from 'react'
import { getSession, signOut, type SessionUser } from './api'
import Shell from './Shell'
import SignIn from './SignIn'

type State = { kind: 'loading' } | { kind: 'signed_out' } | { kind: 'signed_in'; user: SessionUser }

function App() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    void getSession().then((user) => {
      if (!cancelled) setState(user ? { kind: 'signed_in', user } : { kind: 'signed_out' })
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSignOut() {
    await signOut()
    setState({ kind: 'signed_out' })
  }

  switch (state.kind) {
    case 'loading':
      return <p className="loading">Cargando…</p>
    case 'signed_out':
      return <SignIn onSignedIn={(user) => setState({ kind: 'signed_in', user })} />
    case 'signed_in':
      return <Shell user={state.user} onSignOut={() => void handleSignOut()} />
  }
}

export default App
