import { useSyncExternalStore } from 'react'

export const NARROW_MQ = '(max-width: 767px)'
export const TOUCH_MQ = '(any-pointer: coarse)'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia === 'undefined') return () => {}
      const mq = matchMedia(query)
      // Safari < 14 has no addEventListener on MediaQueryList; fall back to
      // the deprecated addListener/removeListener pair it replaced.
      if (mq.addEventListener) {
        mq.addEventListener('change', cb)
        return () => mq.removeEventListener('change', cb)
      }
      mq.addListener?.(cb)
      return () => mq.removeListener?.(cb)
    },
    () => typeof matchMedia !== 'undefined' && matchMedia(query).matches,
    () => false,
  )
}

/** Layout: phone-width viewport. Live — rotation / window resize update it (B11). */
export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_MQ)
}

/** Input: touch-capable device. maxTouchPoints catches touch laptops / iPad
 *  with a trackpad, matching TerminalView's previous detection. */
export function useIsTouch(): boolean {
  const coarse = useMediaQuery(TOUCH_MQ)
  return coarse || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
}
