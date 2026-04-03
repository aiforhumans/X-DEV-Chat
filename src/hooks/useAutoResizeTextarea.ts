import { useEffect } from 'react'
import type { RefObject } from 'react'

export const autoResizeTextarea = (element: HTMLTextAreaElement | null): void => {
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${element.scrollHeight}px`
}

export const useAutoResizeTextarea = (
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void => {
  useEffect(() => {
    autoResizeTextarea(ref.current)
  }, [ref, value])
}
