import { useInView, useMotionValue, useReducedMotion, useSpring } from "motion/react"
import { type ComponentPropsWithoutRef, type ReactElement, useEffect, useRef } from "react"
import { cn } from "../lib/cn.ts"

interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
  value: number
  startValue?: number
  direction?: "up" | "down"
  delay?: number
  decimalPlaces?: number
}

export function NumberTicker({
  value,
  startValue = 0,
  direction = "up",
  delay = 0,
  className,
  decimalPlaces = 0,
  ...props
}: NumberTickerProps): ReactElement {
  const ref = useRef<HTMLSpanElement>(null)
  const reduceMotion = useReducedMotion()
  const finalValue = direction === "down" ? startValue : value
  const motionValue = useMotionValue(direction === "down" ? value : startValue)
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 })
  const isInView = useInView(ref, { once: true, margin: "0px" })

  useEffect(() => {
    if (!isInView || reduceMotion) return
    const timer = setTimeout(() => {
      motionValue.set(finalValue)
    }, delay * 1000)
    return () => clearTimeout(timer)
  }, [motionValue, isInView, reduceMotion, delay, finalValue])

  useEffect(() => {
    if (reduceMotion) return
    return springValue.on("change", (latest) => {
      if (ref.current) {
        ref.current.textContent = Intl.NumberFormat("en-US", {
          minimumFractionDigits: decimalPlaces,
          maximumFractionDigits: decimalPlaces,
        }).format(Number(latest.toFixed(decimalPlaces)))
      }
    })
  }, [springValue, reduceMotion, decimalPlaces])

  const renderedValue = reduceMotion ? finalValue : startValue

  return (
    <span ref={ref} className={cn("number-ticker", className)} {...props}>
      {Intl.NumberFormat("en-US", {
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces,
      }).format(renderedValue)}
    </span>
  )
}
