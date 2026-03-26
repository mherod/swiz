import * as THREE from "three"

// ── Colors (from the SVG palette) ──────────────────────────
const C = {
  body: 0x3f4040,
  teal: 0x4fcdcc,
  cyan: 0x12e9eb,
  pale: 0xa5dfdc,
  honeycomb: 0xf2f3ed,
  bg: 0x09090b,
}

// ── Materials ──────────────────────────────────────────────
const bodyMat = new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.65, metalness: 0.05 })
const eyeOuterMat = new THREE.MeshStandardMaterial({
  color: C.teal,
  roughness: 0.3,
  metalness: 0.1,
})
const eyeInnerMat = new THREE.MeshStandardMaterial({
  color: C.cyan,
  roughness: 0.2,
  metalness: 0.15,
  emissive: C.cyan,
  emissiveIntensity: 0.15,
})
const wingMat = new THREE.MeshStandardMaterial({
  color: C.cyan,
  roughness: 0.2,
  metalness: 0.1,
  transparent: true,
  opacity: 0.55,
  side: THREE.DoubleSide,
  emissive: C.cyan,
  emissiveIntensity: 0.08,
})
const wingAccentMat = new THREE.MeshStandardMaterial({
  color: C.teal,
  roughness: 0.3,
  metalness: 0.05,
  transparent: true,
  opacity: 0.35,
  side: THREE.DoubleSide,
})
const mouthMat = new THREE.MeshStandardMaterial({
  color: C.teal,
  roughness: 0.4,
  side: THREE.DoubleSide,
})
const hexMat = new THREE.MeshStandardMaterial({
  color: C.honeycomb,
  roughness: 0.5,
  metalness: 0.0,
})
const hexBorderMat = new THREE.MeshStandardMaterial({
  color: C.teal,
  roughness: 0.4,
  metalness: 0.1,
})
const stripeMat = new THREE.MeshStandardMaterial({ color: C.teal, roughness: 0.4, metalness: 0.05 })
const antennaMat = new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.6 })
const antennaTipMat = new THREE.MeshStandardMaterial({
  color: C.teal,
  roughness: 0.3,
  emissive: C.cyan,
  emissiveIntensity: 0.1,
})

// ── Geometry builders ─────────────────────────────────────

/** @returns {THREE.Mesh} */
function buildBody() {
  const profile = [
    [0, 1.35],
    [0.42, 1.2],
    [0.65, 0.95],
    [0.72, 0.7],
    [0.58, 0.4],
    [0.52, 0.2],
    [0.55, 0.0],
    [0.62, -0.2],
    [0.72, -0.45],
    [0.74, -0.7],
    [0.68, -0.95],
    [0.5, -1.15],
    [0.25, -1.3],
    [0, -1.35],
  ]
  const pts = profile.map(([x, y]) => new THREE.Vector2(x, y))
  return new THREE.Mesh(new THREE.LatheGeometry(pts, 32), bodyMat)
}

/** @param {number} x @returns {THREE.Group} */
function buildEye(x) {
  const g = new THREE.Group()
  const outerGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.12, 6)
  outerGeo.rotateX(Math.PI / 2)
  g.add(new THREE.Mesh(outerGeo, eyeOuterMat))
  const innerGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.08, 6)
  innerGeo.rotateX(Math.PI / 2)
  const inner = new THREE.Mesh(innerGeo, eyeInnerMat)
  inner.position.z = 0.08
  g.add(inner)
  g.position.set(x, 0.35, 0.55)
  return g
}

/** @returns {THREE.Mesh} */
function buildMouth() {
  const shape = new THREE.Shape()
  shape.moveTo(-0.25, 0)
  shape.quadraticCurveTo(0, -0.12, 0.25, 0)
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), mouthMat)
  m.position.set(0, -0.15, 0.7)
  return m
}

/** @param {"left"|"right"} side @returns {THREE.Group} */
function buildWing(side) {
  const g = new THREE.Group()
  const s = side === "left" ? -1 : 1
  const ext = { depth: 0.02, bevelEnabled: false }

  const shape = new THREE.Shape()
  shape.moveTo(0, 0)
  shape.bezierCurveTo(s * 0.3, 0.6, s * 1.4, 0.9, s * 1.6, 0.3)
  shape.bezierCurveTo(s * 1.5, -0.1, s * 0.5, -0.15, 0, 0)
  g.add(new THREE.Mesh(new THREE.ExtrudeGeometry(shape, ext), wingMat))

  const shape2 = new THREE.Shape()
  shape2.moveTo(0, 0)
  shape2.bezierCurveTo(s * 0.2, -0.3, s * 1.0, -0.6, s * 1.1, -0.2)
  shape2.bezierCurveTo(s * 1.0, 0.05, s * 0.3, 0.05, 0, 0)
  const lobe = new THREE.Mesh(new THREE.ExtrudeGeometry(shape2, ext), wingAccentMat)
  lobe.position.z = -0.01
  g.add(lobe)

  g.position.set(s * 0.45, 0.55, 0.05)
  return g
}

/** @param {number} x @returns {THREE.Group} */
function buildAntenna(x) {
  const g = new THREE.Group()
  const stalkGeo = new THREE.CylinderGeometry(0.025, 0.03, 0.55, 8)
  const stalk = new THREE.Mesh(stalkGeo, antennaMat)
  stalk.position.y = 0.27
  stalk.rotation.z = x > 0 ? -0.25 : 0.25
  g.add(stalk)
  const tipGeo = new THREE.SphereGeometry(0.055, 12, 8)
  const tip = new THREE.Mesh(tipGeo, antennaTipMat)
  const tilt = x > 0 ? -0.25 : 0.25
  tip.position.set(Math.sin(tilt) * 0.55, 0.27 + Math.cos(tilt) * 0.55, 0)
  g.add(tip)
  g.position.set(x, 1.1, 0.15)
  return g
}

/** @param {number} x @param {number} y @param {number} z @param {number} scale @returns {THREE.Group} */
function buildHexCell(x, y, z, scale) {
  const g = new THREE.Group()
  const bGeo = new THREE.CylinderGeometry(0.12 * scale, 0.12 * scale, 0.06, 6)
  bGeo.rotateX(Math.PI / 2)
  g.add(new THREE.Mesh(bGeo, hexBorderMat))
  const iGeo = new THREE.CylinderGeometry(0.09 * scale, 0.09 * scale, 0.07, 6)
  iGeo.rotateX(Math.PI / 2)
  const inner = new THREE.Mesh(iGeo, hexMat)
  inner.position.z = 0.01
  g.add(inner)
  g.position.set(x, y, z)
  return g
}

/** @param {"left"|"right"} side @returns {THREE.Group} */
function buildSideMarking(side) {
  const s = side === "left" ? -1 : 1
  const g = new THREE.Group()
  const m1 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.04), stripeMat)
  m1.position.set(s * 0.62, 0.1, 0.25)
  m1.rotation.y = s * 0.4
  g.add(m1)
  const m2 = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.04), stripeMat)
  m2.position.set(s * 0.58, -0.15, 0.3)
  m2.rotation.y = s * 0.35
  g.add(m2)
  return g
}

/** @param {THREE.Group} bee @returns {void} */
function assembleBee(bee) {
  bee.add(buildBody())
  bee.add(buildEye(-0.38))
  bee.add(buildEye(0.38))
  bee.add(buildMouth())
  bee.add(buildWing("left"))
  bee.add(buildWing("right"))
  bee.add(buildAntenna(-0.2))
  bee.add(buildAntenna(0.2))

  const hexPositions = [
    [-0.22, -1.0, 0.42, 1.0],
    [0.0, -1.0, 0.48, 1.0],
    [0.22, -1.0, 0.42, 1.0],
    [-0.11, -1.17, 0.35, 0.85],
    [0.11, -1.17, 0.35, 0.85],
    [0.0, -1.3, 0.25, 0.65],
  ]
  for (const [x, y, z, s] of hexPositions) bee.add(buildHexCell(x, y, z, s))

  bee.add(buildSideMarking("left"))
  bee.add(buildSideMarking("right"))
}

// ── Scene setup ────────────────────────────────────────────
/** @param {HTMLElement} container @returns {() => void} */
export function createBeeScene(container) {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  camera.position.set(0, 0, 6)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 0)
  container.appendChild(renderer.domElement)

  scene.add(new THREE.AmbientLight(0xffffff, 0.5))
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0)
  keyLight.position.set(2, 3, 4)
  scene.add(keyLight)
  const rimLight = new THREE.DirectionalLight(C.cyan, 0.3)
  rimLight.position.set(-2, -1, -3)
  scene.add(rimLight)
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.25)
  fillLight.position.set(-3, 1, 2)
  scene.add(fillLight)

  const bee = new THREE.Group()
  scene.add(bee)
  assembleBee(bee)

  // Named children for animation
  const leftWing = bee.children[3] // buildWing("left")
  const rightWing = bee.children[4] // buildWing("right")
  const leftAntenna = bee.children[5]
  const rightAntenna = bee.children[6]

  const mouse = { x: 0, y: 0 }
  const targetRotation = { x: 0, y: 0 }

  /** @param {MouseEvent} e */
  function onMouseMove(e) {
    const rect = container.getBoundingClientRect()
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }
  window.addEventListener("mousemove", onMouseMove)

  function resize() {
    const w = container.clientWidth
    const h = container.clientHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  }
  resize()
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)

  const clock = new THREE.Clock()
  function animate() {
    const t = clock.getElapsedTime()
    bee.position.y = Math.sin(t * Math.PI) * 0.08
    const flapAngle = Math.sin(t * 48) * 0.35
    leftWing.rotation.y = flapAngle
    rightWing.rotation.y = -flapAngle
    const liftAngle = Math.sin(t * 3) * 0.05
    leftWing.rotation.z = -0.1 + liftAngle
    rightWing.rotation.z = 0.1 - liftAngle
    leftAntenna.rotation.z = Math.sin(t * 2.5) * 0.06
    rightAntenna.rotation.z = -Math.sin(t * 2.5 + 0.5) * 0.06
    targetRotation.y = mouse.x * 0.4
    targetRotation.x = -mouse.y * 0.25
    bee.rotation.y += (targetRotation.y - bee.rotation.y) * 0.05
    bee.rotation.x += (targetRotation.x - bee.rotation.x) * 0.05
    renderer.render(scene, camera)
    requestAnimationFrame(animate)
  }
  animate()

  return function dispose() {
    resizeObserver.disconnect()
    window.removeEventListener("mousemove", onMouseMove)
    renderer.dispose()
    container.removeChild(renderer.domElement)
  }
}
