import "./index.css";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { TabbyMcpPage } from "./pages/TabbyMcpPage";
import { TabbyPage } from "./pages/TabbyPage";

const root = document.getElementById("root") as HTMLElement;
createRoot(root).render(
	<BrowserRouter>
		<Routes>
			<Route element={<Layout />}>
				<Route index element={<Navigate to="/tabby" replace />} />
				<Route path="tabby" element={<TabbyPage />} />
				<Route path="tabby/mcp" element={<TabbyMcpPage />} />
				<Route path="*" element={<Navigate to="/tabby" replace />} />
			</Route>
		</Routes>
	</BrowserRouter>,
);
