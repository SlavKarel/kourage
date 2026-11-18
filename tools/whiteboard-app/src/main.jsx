import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import './style.css'

const boardId = Number(new URLSearchParams(location.search).get('board'))
const savedTheme = () => {
  try {
    const value = localStorage.getItem('kourage-theme')
    if (value === 'dark' || value === 'light') return value
  } catch { /* Use the system theme when storage is unavailable. */ }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
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

const pointHitsElement = (point, element, padding) => {
  if (!element || element.isDeleted) return false
  const width = Math.max(1, Number(element.width) || 0)
  const height = Math.max(1, Number(element.height) || 0)
  const x = Number(element.x) || 0
  const y = Number(element.y) || 0
  const angle = Number(element.angle) || 0
  const centerX = x + width / 2
  const centerY = y + height / 2
  const dx = point.x - centerX
  const dy = point.y - centerY
  const cos = Math.cos(-angle)
  const sin = Math.sin(-angle)
  const localX = centerX + dx * cos - dy * sin
  const localY = centerY + dx * sin + dy * cos
  return localX >= x - padding && localX <= x + width + padding
    && localY >= y - padding && localY <= y + height + padding
}

function Board() {
  const [state, setState] = useState({ status: 'loading', elements: [], files: {} })
  const [theme, setTheme] = useState(savedTheme)
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
  const activeToolRef = useRef('selection')
  const pointerMovedAtRef = useRef(0)
  const wakePresenceRef = useRef(() => {})
  const presenceSendingRef = useRef(false)
  const selectedRef = useRef({})
  const collaboratorsSignatureRef = useRef('')
  const collaboratorsRef = useRef(new Map())
  const collaboratorsAnimationRef = useRef(0)
  const peersActiveUntilRef = useRef(0)
  const shellRef = useRef(null)
  const canvasPanRef = useRef(null)
  const suppressContextMenuUntilRef = useRef(0)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    const syncTheme = event => {
      if (event.key === 'kourage-theme') setTheme(savedTheme())
    }
    addEventListener('storage', syncTheme)
    return () => removeEventListener('storage', syncTheme)
  }, [theme])

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem('kourage-theme', next) } catch { /* The current page can still switch theme. */ }
    setTheme(next)
  }

  useEffect(() => {
    if (!Number.isInteger(boardId) || boardId < 1) {
      setState(current => ({ ...current, status: 'error', error: 'Не указана доска.' }))
      return
    }
    let pollTimer = 0
    let presenceTimer = 0

    const animateCollaborators = targets => {
      const editor = excalidrawRef.current
      if (!editor) return
      cancelAnimationFrame(collaboratorsAnimationRef.current)
      const starts = new Map()
      for (const [id, target] of targets) {
        const current = collaboratorsRef.current.get(id)
        starts.set(id, current?.pointer ? current.pointer : target.pointer)
      }
      const startedAt = performance.now()
      const duration = 145
      let lastPaintAt = 0

      const frame = now => {
        const progress = Math.min(1, (now - startedAt) / duration)
        if (progress === 1 || now - lastPaintAt >= 30) {
          lastPaintAt = now
          const displayed = new Map()
          for (const [id, target] of targets) {
            const start = starts.get(id)
            const pointer = start && target.pointer
              ? {
                  x: start.x + (target.pointer.x - start.x) * progress,
                  y: start.y + (target.pointer.y - start.y) * progress,
                }
              : target.pointer
            displayed.set(id, { ...target, pointer })
          }
          collaboratorsRef.current = displayed
          editor.updateScene({ collaborators: displayed })
        }
        if (progress < 1) collaboratorsAnimationRef.current = requestAnimationFrame(frame)
        else {
          collaboratorsAnimationRef.current = 0
        }
      }
      collaboratorsAnimationRef.current = requestAnimationFrame(frame)
    }

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
          const existing = elementsRef.current.get(element.id)
          if (existing) {
            const incomingVersion = Number(element.version) || 0
            const existingVersion = Number(existing.version) || 0
            if (incomingVersion < existingVersion || (incomingVersion === existingVersion && existing.isDeleted && !element.isDeleted)) continue
          }
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
        const applied = applyRecords(event.changed, event.removed, false)
        sceneChanged ||= applied.sceneChanged
        addedFiles.push(...applied.addedFiles)
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
        window.setTimeout(flush, 700)
      } finally {
        sendingRef.current = false
        if (queueRef.current.changed.size || queueRef.current.removed.size) sendTimerRef.current = window.setTimeout(flush, 350)
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
      const hasActivePeer = Date.now() < peersActiveUntilRef.current
      pollTimer = window.setTimeout(poll, document.hidden ? 8000 : (hasActivePeer ? 800 : 1800))
    }

    const syncPresence = async () => {
      const editor = excalidrawRef.current
      const user = userRef.current
      if (stoppedRef.current) return
      if (presenceSendingRef.current) {
        presenceTimer = window.setTimeout(syncPresence, 80)
        return
      }
      if (!editor || !user) {
        presenceTimer = window.setTimeout(syncPresence, document.hidden ? 8000 : 2500)
        return
      }
      const color = palette[Number(user.id) % palette.length]
      presenceSendingRef.current = true
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
        if (collaborators.size) peersActiveUntilRef.current = Date.now() + 4000
        const signature = JSON.stringify([...collaborators].map(([id, peer]) => [id, peer.pointer, peer.selectedElementIds, peer.button]))
        if (signature !== collaboratorsSignatureRef.current) {
          collaboratorsSignatureRef.current = signature
          animateCollaborators(collaborators)
        }
      } catch { /* Presence is ephemeral and restored by the next heartbeat. */ }
      finally { presenceSendingRef.current = false }
      const pointerIsMoving = Date.now() - pointerMovedAtRef.current < 1200
      presenceTimer = window.setTimeout(syncPresence, document.hidden ? 8000 : (pointerIsMoving ? 160 : 1000))
    }
    wakePresenceRef.current = () => {
      if (stoppedRef.current || presenceSendingRef.current) return
      clearTimeout(presenceTimer)
      presenceTimer = window.setTimeout(syncPresence, 0)
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
        pollTimer = window.setTimeout(poll, 400)
        presenceTimer = window.setTimeout(syncPresence, 150)
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
      cancelAnimationFrame(collaboratorsAnimationRef.current)
      collaboratorsAnimationRef.current = 0
      wakePresenceRef.current = () => {}
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
      sendTimerRef.current = window.setTimeout(() => flushRef.current(), 350)
    }
  }

  const handleChange = (elements, appState, files) => {
    if (state.status !== 'ready') return
    selectedRef.current = appState.selectedElementIds || {}
    activeToolRef.current = appState.activeTool?.type || 'selection'
    pendingChangeRef.current = { elements, files }
    const erasing = activeToolRef.current === 'eraser' && (pointerButtonRef.current === 'down' || appState.cursorButton === 'down')
    if (erasing) {
      clearTimeout(changeTimerRef.current)
      changeTimerRef.current = 0
      return
    }
    if (!changeTimerRef.current) changeTimerRef.current = window.setTimeout(processPendingChange, 120)
  }

  const beginCanvasPan = event => {
    const editor = excalidrawRef.current
    if (!editor || event.button !== 2 || !(event.target instanceof HTMLCanvasElement)) return
    const appState = editor.getAppState()
    if (appState.activeTool?.type !== 'selection' || appState.editingTextElement) return
    const point = viewportCoordsToSceneCoords(
      { clientX: event.clientX, clientY: event.clientY },
      appState,
    )
    const padding = 8 / Math.max(0.1, appState.zoom?.value || 1)
    const clickedElement = editor.getSceneElements().some(element => pointHitsElement(point, element, padding))
    if (clickedElement) return

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    canvasPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: Math.max(0.1, appState.zoom?.value || 1),
      moved: false,
    }
    shellRef.current?.classList.add('board-panning')
    editor.updateScene({ appState: { selectedElementIds: {} } })
  }

  const moveCanvasPan = event => {
    const pan = canvasPanRef.current
    const editor = excalidrawRef.current
    if (!pan || !editor || event.pointerId !== pan.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (Math.abs(event.clientX - pan.startX) > 3 || Math.abs(event.clientY - pan.startY) > 3) pan.moved = true
    editor.updateScene({
      appState: {
        scrollX: pan.scrollX + (event.clientX - pan.startX) / pan.zoom,
        scrollY: pan.scrollY + (event.clientY - pan.startY) / pan.zoom,
      },
    })
  }

  const endCanvasPan = event => {
    const pan = canvasPanRef.current
    if (!pan || event.pointerId !== pan.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (pan.moved) suppressContextMenuUntilRef.current = Date.now() + 500
    canvasPanRef.current = null
    shellRef.current?.classList.remove('board-panning')
  }

  const handleCanvasContextMenu = event => {
    if (Date.now() < suppressContextMenuUntilRef.current) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  if (state.status !== 'ready') return <Loading error={state.error} />
  return <div
    ref={shellRef}
    className="whiteboard-shell"
    aria-label={state.title}
    onPointerDownCapture={beginCanvasPan}
    onPointerMoveCapture={moveCanvasPan}
    onPointerUpCapture={endCanvasPan}
    onPointerCancelCapture={endCanvasPan}
    onContextMenuCapture={handleCanvasContextMenu}
  >
    <button className="board-theme-toggle" type="button" onClick={toggleTheme} title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'} aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}>{theme === 'dark' ? '☀' : '☾'}</button>
    <Excalidraw
      theme={theme}
      initialData={{ elements: state.elements, files: state.files, appState: { viewBackgroundColor: '#ffffff' } }}
      excalidrawAPI={apiObject => { excalidrawRef.current = apiObject }}
      onChange={handleChange}
      onPointerUpdate={payload => {
        const wasDrawing = pointerButtonRef.current === 'down'
        const nextPointer = payload?.pointer || null
        const previousPointer = pointerRef.current
        const now = Date.now()
        const pointerChanged = nextPointer && (!previousPointer || Math.abs(nextPointer.x - previousPointer.x) > 0.5 || Math.abs(nextPointer.y - previousPointer.y) > 0.5)
        const wasIdle = now - pointerMovedAtRef.current > 500
        pointerRef.current = nextPointer
        if (pointerChanged) {
          pointerMovedAtRef.current = now
          if (wasIdle) wakePresenceRef.current()
        }
        pointerButtonRef.current = payload?.button || 'up'
        if (wasDrawing && pointerButtonRef.current !== 'down') {
          requestAnimationFrame(() => {
            processPendingChange()
            Promise.resolve(flushRef.current()).finally(() => flushRemoteRef.current())
          })
        }
      }}
      isCollaborating
      langCode="ru-RU"
      UIOptions={{ canvasActions: { saveToActiveFile: false, loadScene: false } }}
    />
  </div>
}

createRoot(document.getElementById('root')).render(<Board />)
