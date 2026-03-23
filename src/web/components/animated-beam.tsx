import { motion } from "motion/react"
import type { RefObject } from "react"
import { useEffect, useId, useState } from "react"
import { cn } from "../lib/cn.ts"

export interface AnimatedBeamProps {
  className?: string
  containerRef: RefObject<HTMLElement | null>
  fromRef: RefObject<HTMLElement | null>
  toRef: RefObject<HTMLElement | null>
  curvature?: number
  reverse?: boolean
  pathColor?: string
  pathWidth?: number
  pathOpacity?: number
  gradientStartColor?: string
  gradientStopColor?: string
  delay?: number
  duration?: number
  startXOffset?: number
  startYOffset?: number
  endXOffset?: number
  endYOffset?: number
}

function computeBeamCoordinates(
  rectA: DOMRect,
  rectB: DOMRect,
  containerRect: DOMRect,
  offsets: { startXOffset: number; startYOffset: number; endXOffset: number; endYOffset: number }
): { startX: number; startY: number; endX: number; endY: number } {
  return {
    startX: rectA.left - containerRect.left + rectA.width / 2 + offsets.startXOffset,
    startY: rectA.top - containerRect.top + rectA.height / 2 + offsets.startYOffset,
    endX: rectB.left - containerRect.left + rectB.width / 2 + offsets.endXOffset,
    endY: rectB.top - containerRect.top + rectB.height / 2 + offsets.endYOffset,
  }
}

function computeSvgPath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  curvature: number
): string {
  const controlY = startY - curvature
  return `M ${startX},${startY} Q ${(startX + endX) / 2},${controlY} ${endX},${endY}`
}

interface AnimatedBeamSvgProps {
  id: string
  pathD: string
  svgDimensions: { width: number; height: number }
  className?: string
  pathColor: string
  pathWidth: number
  pathOpacity: number
  gradientStartColor: string
  gradientStopColor: string
  gradientCoordinates: {
    x1: string[]
    x2: string[]
    y1: string[]
    y2: string[]
  }
  delay: number
  duration: number
}

function AnimatedBeamGradient({
  id,
  startColor,
  stopColor,
  coordinates,
  delay,
  duration,
}: {
  id: string
  startColor: string
  stopColor: string
  coordinates: { x1: string[]; x2: string[]; y1: string[]; y2: string[] }
  delay: number
  duration: number
}) {
  return (
    <motion.linearGradient
      className="transform-gpu"
      id={id}
      gradientUnits="userSpaceOnUse"
      initial={{ x1: "0%", x2: "0%", y1: "0%", y2: "0%" }}
      animate={{
        x1: coordinates.x1,
        x2: coordinates.x2,
        y1: coordinates.y1,
        y2: coordinates.y2,
      }}
      transition={{ delay, duration, ease: [0.16, 1, 0.3, 1], repeat: Infinity, repeatDelay: 0 }}
    >
      <stop stopColor={startColor} stopOpacity="0" />
      <stop stopColor={startColor} />
      <stop offset="32.5%" stopColor={stopColor} />
      <stop offset="100%" stopColor={stopColor} stopOpacity="0" />
    </motion.linearGradient>
  )
}

function AnimatedBeamSvg({
  id,
  pathD,
  svgDimensions,
  className,
  pathColor,
  pathWidth,
  pathOpacity,
  gradientStartColor,
  gradientStopColor,
  gradientCoordinates,
  delay,
  duration,
}: AnimatedBeamSvgProps) {
  return (
    <svg
      fill="none"
      width={svgDimensions.width}
      height={svgDimensions.height}
      xmlns="http://www.w3.org/2000/svg"
      className={cn("animated-beam", className)}
      viewBox={`0 0 ${svgDimensions.width} ${svgDimensions.height}`}
      role="img"
      aria-label="Animated beam connecting elements"
    >
      <path
        d={pathD}
        stroke={pathColor}
        strokeWidth={pathWidth}
        strokeOpacity={pathOpacity}
        strokeLinecap="round"
      />
      <path
        d={pathD}
        strokeWidth={pathWidth}
        stroke={`url(#${id})`}
        strokeOpacity="1"
        strokeLinecap="round"
      />
      <defs>
        <AnimatedBeamGradient
          id={id}
          startColor={gradientStartColor}
          stopColor={gradientStopColor}
          coordinates={gradientCoordinates}
          delay={delay}
          duration={duration}
        />
      </defs>
    </svg>
  )
}

interface BeamUpdateState {
  containerRef: RefObject<HTMLElement | null>
  fromRef: RefObject<HTMLElement | null>
  toRef: RefObject<HTMLElement | null>
  offsets: { startXOffset: number; startYOffset: number; endXOffset: number; endYOffset: number }
  curvature: number
}

function useAnimatedBeamPath(
  state: BeamUpdateState,
  setPathD: (path: string) => void,
  setSvgDimensions: (dims: { width: number; height: number }) => void
) {
  useEffect(() => {
    const updatePath = () => {
      if (!state.containerRef.current || !state.fromRef.current || !state.toRef.current) return
      const containerRect = state.containerRef.current.getBoundingClientRect()
      const coords = computeBeamCoordinates(
        state.fromRef.current.getBoundingClientRect(),
        state.toRef.current.getBoundingClientRect(),
        containerRect,
        state.offsets
      )
      setSvgDimensions({ width: containerRect.width, height: containerRect.height })
      setPathD(
        computeSvgPath(coords.startX, coords.startY, coords.endX, coords.endY, state.curvature)
      )
    }

    const resizeObserver = new ResizeObserver(() => updatePath())
    if (state.containerRef.current) resizeObserver.observe(state.containerRef.current)
    updatePath()
    return () => resizeObserver.disconnect()
  }, [state, setPathD, setSvgDimensions])
}

export function AnimatedBeam({
  className,
  containerRef,
  fromRef,
  toRef,
  curvature = 0,
  reverse = false,
  duration = Math.random() * 3 + 4,
  delay = 0,
  pathColor = "gray",
  pathWidth = 2,
  pathOpacity = 0.2,
  gradientStartColor = "#ffaa40",
  gradientStopColor = "#9c40ff",
  startXOffset = 0,
  startYOffset = 0,
  endXOffset = 0,
  endYOffset = 0,
}: AnimatedBeamProps) {
  const id = useId()
  const [pathD, setPathD] = useState("")
  const [svgDimensions, setSvgDimensions] = useState({ width: 0, height: 0 })

  const gradientCoordinates = reverse
    ? { x1: ["90%", "-10%"], x2: ["100%", "0%"], y1: ["0%", "0%"], y2: ["0%", "0%"] }
    : { x1: ["10%", "110%"], x2: ["0%", "100%"], y1: ["0%", "0%"], y2: ["0%", "0%"] }

  useAnimatedBeamPath(
    {
      containerRef,
      fromRef,
      toRef,
      offsets: { startXOffset, startYOffset, endXOffset, endYOffset },
      curvature,
    },
    setPathD,
    setSvgDimensions
  )

  return (
    <AnimatedBeamSvg
      id={id}
      pathD={pathD}
      svgDimensions={svgDimensions}
      className={className}
      pathColor={pathColor}
      pathWidth={pathWidth}
      pathOpacity={pathOpacity}
      gradientStartColor={gradientStartColor}
      gradientStopColor={gradientStopColor}
      gradientCoordinates={gradientCoordinates}
      delay={delay}
      duration={duration}
    />
  )
}
