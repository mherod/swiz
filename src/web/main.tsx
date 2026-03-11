import { createRoot } from "react-dom/client"
import { DashboardApp } from "./components/dashboard-app.tsx"

const root = createRoot(document.getElementById("app")!)
root.render(<DashboardApp />)
