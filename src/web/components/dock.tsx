import type { MotionProps } from "motion/react"
import {
  type MotionValue,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react"
import React, { type PropsWithChildren, type ReactElement, useRef } from "react"
import { cn } from "../lib/cn.ts"

const DEFAULT_SIZE = 40
const DEFAULT_MAGNIFICATION = 60
const DEFAULT_DISTANCE = 140

export interface DockProps {
  className?: string
  iconSize?: number
  iconMagnification?: number
  disableMagnification?: boolean
  iconDistance?: number
  direction?: "top" | "middle" | "bottom"
  children: React.ReactNode
}

export function Dock({
  className,
  children,
  iconSize = DEFAULT_SIZE,
  iconMagnification = DEFAULT_MAGNIFICATION,
  disableMagnification = false,
  iconDistance = DEFAULT_DISTANCE,
  direction = "middle",
}: DockProps): ReactElement {
  const mouseX = useMotionValue(Infinity)
  const reduceMotion = useReducedMotion()
  const magnificationDisabled = Boolean(disableMagnification || reduceMotion)

  const rendered = React.Children.map(children, (child) => {
    if (React.isValidElement<DockIconProps>(child) && child.type === DockIcon) {
      return React.cloneElement(child, {
        ...child.props,
        mouseX,
        size: child.props.size ?? iconSize,
        magnification: child.props.magnification ?? iconMagnification,
        disableMagnification: child.props.disableMagnification ?? magnificationDisabled,
        distance: child.props.distance ?? iconDistance,
      })
    }
    return child
  })

  const directionClass =
    direction === "top" ? "dock-top" : direction === "bottom" ? "dock-bottom" : ""

  return (
    <motion.nav
      aria-label="Dashboard views"
      onPointerMove={(e) => {
        if (!magnificationDisabled && e.pointerType === "mouse") mouseX.set(e.clientX)
      }}
      onPointerLeave={() => mouseX.set(Infinity)}
      className={cn("dock", directionClass, className)}
    >
      {rendered}
    </motion.nav>
  )
}

export interface DockIconProps
  extends Omit<MotionProps & React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  size?: number
  magnification?: number
  disableMagnification?: boolean
  distance?: number
  mouseX?: MotionValue<number>
  className?: string
  children?: React.ReactNode
  props?: PropsWithChildren
}

export function DockIcon({
  size = DEFAULT_SIZE,
  magnification = DEFAULT_MAGNIFICATION,
  disableMagnification,
  distance = DEFAULT_DISTANCE,
  mouseX,
  className,
  children,
  ...props
}: DockIconProps): ReactElement {
  const ref = useRef<HTMLButtonElement>(null)
  const padding = Math.max(4, size * 0.1)
  const defaultMouseX = useMotionValue(Infinity)

  const distanceCalc = useTransform(mouseX ?? defaultMouseX, (val: number) => {
    const bounds = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 }
    return val - bounds.x - bounds.width / 2
  })

  const targetScale = disableMagnification ? 1 : magnification / size

  const scaleTransform = useTransform(distanceCalc, [-distance, 0, distance], [1, targetScale, 1])
  const scale = useSpring(scaleTransform, { mass: 0.1, stiffness: 150, damping: 12 })

  return (
    <motion.button
      ref={ref}
      type="button"
      style={{ width: size, height: size, padding, scale }}
      className={cn("dock-icon", className)}
      {...props}
    >
      <div>{children}</div>
    </motion.button>
  )
}
