import React, { useEffect, useId, useRef, useState } from 'react'

/** Native modality confines focus without changing the host page's CSS or scroll state. */
export function Dialog({ title, children, onClose, busy = false, dirty = false }: React.PropsWithChildren<{
  title: string; onClose(): void; busy?: boolean; dirty?: boolean
}>) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [confirmClose, setConfirmClose] = useState(false)
  const requestClose = () => { if (!busy) dirty ? setConfirmClose(true) : onClose() }
  useEffect(() => {
    const node = ref.current!
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    node.showModal()
    return () => { node.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  return <dialog ref={ref} className="mc-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); requestClose() }}
    onKeyDown={event => event.stopPropagation()}>
    <header className="mc-dialog-head"><h2 id={titleId}>{title}</h2>
      <button type="button" className="mc-icon-button" aria-label={`关闭${title}`} onClick={requestClose} disabled={busy}>×</button>
    </header>
    {confirmClose && <div className="mc-notice warn" role="alert">尚有未保存的输入。
      <div className="mc-actions"><button type="button" onClick={() => setConfirmClose(false)}>继续编辑</button>
        <button type="button" className="mc-danger" onClick={onClose}>放弃输入并关闭</button></div></div>}
    {children}
  </dialog>
}
