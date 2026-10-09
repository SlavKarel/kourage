import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import './style.css'

const boardId = Number(new URLSearchParams(location.search).get('board'))
const palette = [
  { background: '#dbe7ff', stroke: '#2457e8' },
  { background: '#ffe2e2', stroke: '#d9363e' },
  { background: '#dff7e8', stroke: '#218358' },
  { background: '#eee3ff', stroke: '#7c3aed' },
  { background: '#ffead7', stroke: '#c75b12' },
  { background: '#d9f2ff', stroke: '#087ea4' },
]

async function api(action, { method = 'GET', csrf = '', body, query = {} } = {}) {
  const params = new URLSearchParams({ action, ...query })
  const response = await fetch(`api.php?${params}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const result = await response.json().catch(() => ({ error: 'Сервер не ответил.' }))
  if (!response.ok) throw new Error(result.error || 'Не удалось открыть доску.')
  return result
}

function Loading({ error }) {
  return <main className="board-state"><div className="board-logo">K</div><h1>{error ? 'Доска пока недоступна' : 'Открываем доску…'}</h1>{error && <><p>{error}</p><button onClick={() => location.reload()}>Попробовать снова</button></>}</main>
}

const elementRecord = element => ({ id: `element:${element.id}`, kind: 'element', data: element })
const fileRecord = file => ({ id: `file:${file.id}`, kind: 'file', data: file })
const elementSignature = element => `${element.version || 0}:${element.versionNonce || 0}:${element.isDeleted ? 1 : 0}`

function Board() {
  const [state, setState] = useState({ status: 'loading', elements: [], files: {} })
  const excalidrawRef = useRef(null)
  const csrfRef = useRef('')
  const userRef = useRef(null)
  const revisionRef = useRef(0)
  const stoppedRef = useRef(false)
  const queueRef = useRef({ changed: new Map(), removed: new Set() })
  const sendingRef = useRef(false)
  const sendTimerRef = useRef(0)
  const changeTimerRef = useRef(0)
  const flushRef = useRef(() => {})
  const flushRemoteRef = useRef(() => {})
  const pendingChangeRef = useRef(null)
  const deferredRemoteRef = useRef({ sceneChanged: false, files: new Map() })
  const elementsRef = useRef(new Map())
  const filesRef = useRef({})
  const signaturesRef = useRef(new Map())
  const knownFilesRef = useRef(new Set())
  const pointerRef = useRef(null)
  const pointerButtonRef = useRef('up')
  const selectedRef = useRef({})
  const collaboratorsSignatureRef = useRef('')

  useEffect(() => {
    if (!Number.isInteger(boardId) || boardId < 1) {
      setState(current => ({ ...current, status: 'error', error: 'Не указана доска.' }))
      return
    }
    let pollTimer = 0
    let presenceTimer = 0

    const renderRemoteScene = (sceneChanged, addedFiles) => {
      const editor = excalidrawRef.current
      const deferred = deferredRemoteRef.current
      if (!editor || pointerButtonRef.current === 'down') {
        deferred.sceneChanged ||= sceneChanged
        for (const file of addedFiles) deferred.files.set(file.id, file)
        return
      }
      sceneChanged ||= deferred.sceneChanged
      for (const file of addedFiles) deferred.files.set(file.id, file)
      const files = [...deferred.files.values()]
      deferredRemoteRef.current = { sceneChanged: false, files: new Map() }
      if (files.length) editor.addFiles(files)
      if (sceneChanged) editor.updateScene({ elements: [...elementsRef.current.values()] })
    }
    flushRemoteRef.current = () => renderRemoteScene(false, [])

    const applyRecords = (records, removed = [], render = true) => {
      let sceneChanged = false
      const addedFiles = []
      for (const record of records || []) {
        if (!record || typeof record !== 'object') continue
        if (record.kind === 'element' && record.data?.id) {
          const element = record.data
          elementsRef.current.set(element.id, element)
          signaturesRef.current.set(element.id, elementSignature(element))
          sceneChanged = true
        } else if (record.kind === 'file' && record.data?.id) {
          const file = record.data
          filesRef.current[file.id] = file
          if (!knownFilesRef.current.has(file.id)) addedFiles.push(file)
          knownFilesRef.current.add(file.id)
        }
      }
      for (const recordId of removed || []) {
        if (recordId.startsWith('element:')) {
          const id = recordId.slice(8)
          elementsRef.current.delete(id)
          signaturesRef.current.delete(id)
          sceneChanged = true
        } else if (recordId.startsWith('file:')) {
          const id = recordId.slice(5)
          delete filesRef.current[id]
          knownFilesRef.current.delete(id)
        }
      }
      if (render) renderRemoteScene(sceneChanged, addedFiles)
      return { sceneChanged, addedFiles }
    }

    const applyEvents = (events, localRevision = 0) => {
      let sceneChanged = false
      const addedFiles = []
      for (const event of events || []) {
        const revision = Number(event.revision) || 0
        if (revision <= revisionRef.current) continue
        const isOwnRoundTrip = revision === Number(localRevision) && Number(event.actor_id) === Number(userRef.current?.id)
        if (!isOwnRoundTrip) {
          const applied = applyRecords(event.changed, event.removed, false)
          sceneChanged ||= applied.sceneChanged
          addedFiles.push(...applied.addedFiles)
        }
        revisionRef.current = revision
      }
      renderRemoteScene(sceneChanged, addedFiles)
    }

    const flush = async () => {
      if (sendingRef.current || stoppedRef.current || (!queueRef.current.changed.size && !queueRef.current.removed.size)) return
      const changed = [...queueRef.current.changed.values()]
      const removed = [...queueRef.current.removed]
      queueRef.current = { changed: new Map(), removed: new Set() }
      sendingRef.current = true
      try {
        const result = await api('whiteboard_sync', {
          method: 'POST',
          csrf: csrfRef.current,
          body: { board_id: boardId, since: revisionRef.current, changed, removed },
        })
        applyEvents(result.events, result.revision)
        revisionRef.current = Math.max(revisionRef.current, Number(result.revision) || 0)
      } catch {
        for (const record of changed) queueRef.current.changed.set(record.id, record)
        for (const recordId of removed) queueRef.current.removed.add(recordId)
        window.setTimeout(flush, 1200)
      } finally {
        sendingRef.current = false
        if (queueRef.current.changed.size || queueRef.current.removed.size) sendTimerRef.current = window.setTimeout(flush, 180)
      }
    }
    flushRef.current = flush

    const poll = async () => {
      if (stoppedRef.current) return
      try {
        const result = await api('whiteboard_document', { query: { board: boardId, since: revisionRef.current } })
        if (result.reset) {
          elementsRef.current = new Map()
          filesRef.current = {}
          signaturesRef.current = new Map()
          knownFilesRef.current = new Set()
          applyRecords(result.records)
        } else applyEvents(result.events)
        revisionRef.current = Math.max(revisionRef.current, Number(result.revision) || 0)
      } catch { /* The next poll retries a temporary network failure. */ }
      pollTimer = window.setTimeout(poll, 650)
    }

    const syncPresence = async () => {
      const editor = excalidrawRef.current
      const user = userRef.current
      if (stoppedRef.current) return
      if (!editor || !user) {
        presenceTimer = window.setTimeout(syncPresence, 800)
        return
      }
      const color = palette[Number(user.id) % palette.length]
      try {
        const result = await api('whiteboard_presence', {
          method: 'POST',
          csrf: csrfRef.current,
          body: {
            board_id: boardId,
            presence: {
              username: user.name,
              color,
              pointer: pointerRef.current,
              selectedElementIds: selectedRef.current,
              button: pointerButtonRef.current,
            },
          },
        })
        const collaborators = new Map()
        for (const peer of result.peers || []) {
          const presence = peer.presence || {}
          collaborators.set(String(peer.user_id), {
            id: String(peer.user_id),
            username: presence.username || 'Участник',
            color: presence.color || palette[Number(peer.user_id) % palette.length],
            pointer: presence.pointer || undefined,
            selectedElementIds: presence.selectedElementIds || {},
            button: presence.button || 'up',
          })
        }
        const signature = JSON.stringify([...collaborators].map(([id, peer]) => [id, peer.pointer, peer.selectedElementIds, peer.button]))
        if (signature !== collaboratorsSignatureRef.current) {
          collaboratorsSignatureRef.current = signature
          editor.updateScene({ collaborators })
        }
      } catch { /* Presence is ephemeral and restored by the next heartbeat. */ }
      presenceTimer = window.setTimeout(syncPresence, 800)
    }

    ;(async () => {
      try {
        const initial = await api('whiteboard_document', { query: { board: boardId } })
        csrfRef.current = initial.csrf
        userRef.current = initial.user
        revisionRef.current = Number(initial.revision) || 0
        const elements = []
        const files = {}
        for (const record of initial.records || []) {
          if (record?.kind === 'element' && record.data?.id) {
            elements.push(record.data)
            elementsRef.current.set(record.data.id, record.data)
            signaturesRef.current.set(record.data.id, elementSignature(record.data))
          } else if (record?.kind === 'file' && record.data?.id) {
            files[record.data.id] = record.data
            filesRef.current[record.data.id] = record.data
            knownFilesRef.current.add(record.data.id)
          }
        }
        setState({ status: 'ready', title: initial.board.title, elements, files })
        pollTimer = window.setTimeout(poll, 650)
        presenceTimer = window.setTimeout(syncPresence, 300)
      } catch (error) {
        setState(current => ({ ...current, status: 'error', error: error.message }))
      }
    })()

    return () => {
      stoppedRef.current = true
      clearTimeout(sendTimerRef.current)
      clearTimeout(changeTimerRef.current)
      clearTimeout(pollTimer)
      clearTimeout(presenceTimer)
    }
  }, [])

  const processPendingChange = () => {
    clearTimeout(changeTimerRef.current)
    changeTimerRef.current = 0
    const pending = pendingChangeRef.current
    pendingChangeRef.current = null
    if (!pending || state.status !== 'ready') return
    const { elements, files } = pending
    let changed = false
    const currentIds = new Set(elements.map(element => element.id))
    for (const element of elements) {
      const signature = elementSignature(element)
      if (signaturesRef.current.get(element.id) === signature) continue
      signaturesRef.current.set(element.id, signature)
      elementsRef.current.set(element.id, element)
      const record = elementRecord(element)
      queueRef.current.removed.delete(record.id)
      queueRef.current.changed.set(record.id, record)
      changed = true
    }
    for (const id of [...elementsRef.current.keys()]) {
      if (currentIds.has(id)) continue
      const recordId = `element:${id}`
      elementsRef.current.delete(id)
      signaturesRef.current.delete(id)
      queueRef.current.changed.delete(recordId)
      queueRef.current.removed.add(recordId)
      changed = true
    }
    for (const file of Object.values(files || {})) {
      if (knownFilesRef.current.has(file.id)) continue
      knownFilesRef.current.add(file.id)
      filesRef.current[file.id] = file
      const record = fileRecord(file)
      queueRef.current.removed.delete(record.id)
      queueRef.current.changed.set(record.id, record)
      changed = true
    }
    if (changed) {
      clearTimeout(sendTimerRef.current)
      sendTimerRef.current = window.setTimeout(() => flushRef.current(), 180)
    }
  }

  const handleChange = (elements, appState, files) => {
    if (state.status !== 'ready') return
    selectedRef.current = appState.selectedElementIds || {}
    pendingChangeRef.current = { elements, files }
    if (!changeTimerRef.current) changeTimerRef.current = window.setTimeout(processPendingChange, 100)
  }

  if (state.status !== 'ready') return <Loading error={state.error} />
  return <div className="whiteboard-shell" aria-label={state.title}>
    <Excalidraw
      initialData={{ elements: state.elements, files: state.files, appState: { viewBackgroundColor: '#ffffff' } }}
      excalidrawAPI={apiObject => { excalidrawRef.current = apiObject }}
      onChange={handleChange}
      onPointerUpdate={payload => {
        const wasDrawing = pointerButtonRef.current === 'down'
        pointerRef.current = payload?.pointer || null
        pointerButtonRef.current = payload?.button || 'up'
        if (wasDrawing && pointerButtonRef.current !== 'down') {
          processPendingChange()
          flushRemoteRef.current()
        }
      }}
      isCollaborating
      langCode="ru-RU"
      UIOptions={{ canvasActions: { saveToActiveFile: false, loadScene: false } }}
    />
  </div>
}

createRoot(document.getElementById('root')).render(<Board />)
