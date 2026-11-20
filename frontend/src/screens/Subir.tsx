import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { uploadPhotos } from '../accounts-api'
import { formatPageCount } from '../format'
import { FIELD_ERROR_MESSAGES, PHOTO_TOO_LARGE_MESSAGE, UPLOAD_FAILED_MESSAGE, photoFormatMessage } from '../labels'
import { MAX_PAGES, preparePhoto, type PreparedPhoto } from '../photos'
import { canUpload, movePage, newPage, removePage, withServerErrors, type PageProblem, type UploadPage } from './upload-pages'

type Phase = 'list' | 'uploading' | 'offline'

function problemMessage(problem: PageProblem): string {
  switch (problem.kind) {
    case 'format':
      return photoFormatMessage(problem.format)
    case 'too_large':
      return PHOTO_TOO_LARGE_MESSAGE
    case 'server':
      return FIELD_ERROR_MESSAGES[problem.code]
  }
}

function prepared(page: UploadPage, result: PreparedPhoto, previewUrl: string | null): UploadPage {
  if (result.ok) return { ...page, state: 'ready', blob: result.blob, previewUrl, problem: null }
  const problem: PageProblem =
    result.problem === 'format' ? { kind: 'format', format: result.format } : { kind: 'too_large' }
  return { ...page, state: 'problem', problem }
}

/** *Subir* (4a–4e): photograph or pick the pages, order them, and upload them as one document. */
function Subir() {
  const navigate = useNavigate()
  const [pages, setPages] = useState<UploadPage[]>([])
  const [phase, setPhase] = useState<Phase>('list')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [tooMany, setTooMany] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  // Bumped after each preparation, so the next one starts.
  const [preparedCount, setPreparedCount] = useState(0)

  const cameraInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)
  /** The picked file of each page still being prepared. */
  const files = useRef(new Map<number, File>())
  /** Every object URL this screen made and hasn't revoked yet. */
  const previewUrls = useRef(new Set<string>())
  const pagesRef = useRef(pages)
  const preparing = useRef(false)
  const mounted = useRef(true)
  const upload = useRef<AbortController | null>(null)

  useEffect(() => {
    pagesRef.current = pages
  }, [pages])

  useEffect(() => {
    mounted.current = true
    const urls = previewUrls.current
    return () => {
      mounted.current = false
      upload.current?.abort()
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [])

  // One page at a time, which keeps a phone's memory low.
  useEffect(() => {
    if (preparing.current) return
    const next = pages.find((page) => page.state === 'preparing')
    const file = next === undefined ? undefined : files.current.get(next.key)
    if (next === undefined || file === undefined) return
    preparing.current = true
    void preparePhoto(file).then((result) => {
      preparing.current = false
      files.current.delete(next.key)
      if (!mounted.current) return
      if (pagesRef.current.some((page) => page.key === next.key)) {
        const previewUrl = result.ok ? URL.createObjectURL(result.blob) : null
        if (previewUrl !== null) previewUrls.current.add(previewUrl)
        setPages((current) => current.map((page) => (page.key === next.key ? prepared(page, result, previewUrl) : page)))
      }
      setPreparedCount((n) => n + 1)
    })
  }, [pages, preparedCount])

  function revoke(page: UploadPage) {
    if (page.previewUrl !== null) {
      URL.revokeObjectURL(page.previewUrl)
      previewUrls.current.delete(page.previewUrl)
    }
    files.current.delete(page.key)
  }

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const picked = [...(event.target.files ?? [])]
    // So the same file can be picked again.
    event.target.value = ''
    const room = MAX_PAGES - pages.length
    const added = picked.slice(0, Math.max(0, room)).map((file) => {
      const page = newPage(file.name)
      files.current.set(page.key, file)
      return page
    })
    setTooMany(picked.length > room)
    setMessage(null)
    if (added.length > 0) setPages((current) => [...current, ...added])
  }

  function remove(index: number) {
    const page = pages[index]
    if (page === undefined) return
    revoke(page)
    if (viewing === page.key) setViewing(null)
    setTooMany(false)
    setPages(removePage(pages, index))
  }

  function discardAll() {
    for (const page of pages) revoke(page)
    setPages([])
    setTooMany(false)
    setMessage(null)
    setPhase('list')
  }

  async function send() {
    const sent = pages
    const blobs = sent.flatMap((page) => (page.blob === null ? [] : [page.blob]))
    const controller = new AbortController()
    upload.current = controller
    setMessage(null)
    setProgress(0)
    setPhase('uploading')
    const result = await uploadPhotos(blobs, { onProgress: setProgress, signal: controller.signal })
    upload.current = null
    if (!mounted.current) return
    if (result.ok) {
      void navigate(`/documentos/${result.id}`, { replace: true, state: { alreadyUploaded: result.alreadyUploaded } })
      return
    }
    switch (result.error) {
      case 'unavailable':
        setPhase('offline')
        return
      case 'rejected':
        setPages(withServerErrors(sent, result.pageErrors))
        if (result.pageErrors.length === 0) setMessage(UPLOAD_FAILED_MESSAGE)
        break
      case 'too_large':
        setMessage('Alguna foto es demasiado grande. Quitala y volvé a intentar.')
        break
      case 'aborted':
      case 'unauthorized':
        break
    }
    setPhase('list')
  }

  const inputs = (
    <>
      <input
        ref={cameraInput}
        className="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        tabIndex={-1}
        aria-hidden="true"
        onChange={addFiles}
      />
      <input
        ref={galleryInput}
        className="visually-hidden"
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={addFiles}
      />
    </>
  )

  if (phase === 'uploading') {
    const percent = Math.round(progress * 100)
    return (
      <section className="screen">
        <h1>Subiendo</h1>
        <p className="notice">Subiendo {formatPageCount(pages.length)}…</p>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <p className="muted">{percent} %</p>
        <button type="button" className="secondary" onClick={() => upload.current?.abort()}>
          Cancelar
        </button>
      </section>
    )
  }

  if (phase === 'offline') {
    return (
      <section className="screen">
        <h1>Subiendo</h1>
        <div className="empty">
          <p className="empty-title">Se cortó la conexión.</p>
          <p className="muted">Las fotos siguen en este teléfono. Cuando vuelva la señal, reintentá.</p>
        </div>
        <div className="buttons">
          <button type="button" onClick={() => void send()}>
            Reintentar
          </button>
          <button type="button" className="secondary" onClick={discardAll}>
            Descartar fotos
          </button>
        </div>
      </section>
    )
  }

  const full = pages.length >= MAX_PAGES
  const hasProblem = pages.some((page) => page.problem !== null)
  const viewed = pages.find((page) => page.key === viewing)

  if (pages.length === 0) {
    return (
      <section className="screen">
        {inputs}
        <h1>Subir documento</h1>
        <p className="muted">Encuadrá la hoja entera. Una foto por página.</p>
        <div className="buttons">
          <button type="button" onClick={() => cameraInput.current?.click()}>
            Sacar foto
          </button>
          <button type="button" className="secondary" onClick={() => galleryInput.current?.click()}>
            Galería
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="screen">
      {inputs}
      <div className="top-bar">
        <Link className="back" to="/subidas" aria-label="Salir sin subir">
          ✕
        </Link>
        <span className="top-title">{formatPageCount(pages.length)}</span>
        <span />
      </div>

      <ol className="list upload-pages">
        {pages.map((page, index) => (
          <li key={page.key} className="upload-page">
            <div className="upload-page-main">
              {page.previewUrl !== null ? (
                <button
                  type="button"
                  className="thumb"
                  aria-label={`Ver página ${index + 1}`}
                  onClick={() => setViewing(page.key)}
                >
                  <img src={page.previewUrl} alt="" />
                </button>
              ) : (
                <span className="thumb thumb-empty">
                  {page.problem?.kind === 'format' ? (page.problem.format ?? '?') : ''}
                </span>
              )}
              <span className="upload-page-title">
                {page.state === 'preparing' ? 'Preparando…' : `Página ${index + 1}`}
              </span>
              <span className="upload-page-actions">
                <button
                  type="button"
                  className="icon"
                  aria-label="Mover antes"
                  disabled={index === 0}
                  onClick={() => setPages(movePage(pages, index, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label="Mover después"
                  disabled={index === pages.length - 1}
                  onClick={() => setPages(movePage(pages, index, 1))}
                >
                  ↓
                </button>
                <button type="button" className="icon" aria-label="Quitar página" onClick={() => remove(index)}>
                  ✕
                </button>
              </span>
            </div>
            {page.problem !== null && (
              <p className="field-error">
                {problemMessage(page.problem)}
                {page.problem.kind === 'server' &&
                  page.problem.code === 'photo_in_other_document' &&
                  page.problem.documentId !== null && (
                    <>
                      {' '}
                      <Link to={`/documentos/${page.problem.documentId}`}>Ver documento</Link>
                    </>
                  )}
              </p>
            )}
          </li>
        ))}
      </ol>

      <div className="pair-buttons">
        <button type="button" className="secondary" disabled={full} onClick={() => cameraInput.current?.click()}>
          + Agregar página
        </button>
        <button type="button" className="secondary" disabled={full} onClick={() => galleryInput.current?.click()}>
          Galería
        </button>
      </div>
      {(full || tooMany) && <p className="muted">Hasta {MAX_PAGES} páginas por documento.</p>}

      {hasProblem && <p className="field-error">Quitá o reemplazá las páginas marcadas para subir.</p>}
      {message !== null && <p className="field-error">{message}</p>}
      <button type="button" disabled={!canUpload(pages)} onClick={() => void send()}>
        Subir documento
      </button>

      {viewed?.previewUrl != null && (
        <div className="photo-viewer" role="dialog" aria-label={`Página ${pages.indexOf(viewed) + 1}`}>
          <img src={viewed.previewUrl} alt={`Página ${pages.indexOf(viewed) + 1}`} />
          <button type="button" onClick={() => setViewing(null)}>
            Cerrar
          </button>
        </div>
      )}
    </section>
  )
}

export default Subir
