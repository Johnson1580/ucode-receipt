"use client";
import { useEffect } from "react";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="box" role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-head"><h2>{title}</h2><div className="right"><button className="btn small" type="button" onClick={onClose} autoFocus>關閉</button></div></div>
        {children}
      </div>
    </div>
  );
}
