import type { MotionProps } from "motion/react"
import { type MotionValue, motion, useMotionValue, useSpring, useTransform } from "motion/react"
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

  const rendered = React.Children.map(children, (child) => {
    if (React.isValidElement<DockIconProps>(child) && child.type === DockIcon) {
      return React.cloneElement(child, {
        ...child.props,
        mouseX,
        size: child.props.size ?? iconSize,
        magnification: child.props.magnification ?? iconMagnification,
        disableMagnification: child.props.disableMagnification ?? disableMagnification,
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
      onMouseMove={(e) => mouseX.set(e.pageX)}
      onMouseLeave={() => mouseX.set(Infinity)}
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
  const padding = Math.max(6, size * 0.2)
  const defaultMouseX = useMotionValue(Infinity)

  const distanceCalc = useTransform(mouseX ?? defaultMouseX, (val: number) => {
    const bounds = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 }
    return val - bounds.x - bounds.width / 2
  })

  const targetSize = disableMagnification ? size : magnification

  const sizeTransform = useTransform(
    distanceCalc,
    [-distance, 0, distance],
    [size, targetSize, size]
  )
  const scaleSize = useSpring(sizeTransform, { mass: 0.1, stiffness: 150, damping: 12 })

  return (
    <motion.button
      ref={ref}
      type="button"
      style={{ width: scaleSize, height: scaleSize, padding }}
      className={cn("dock-icon", className)}
      {...props}
    >
      <div>{children}</div>
    </motion.button>
  )
}
