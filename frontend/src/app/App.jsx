import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import DashboardPage from '../features/projects/DashboardPage';
import ProjectsListPage from '../features/projects/ProjectsListPage';
import CatalogPage from '../features/catalog/CatalogPage';
import VisualizeRedirect from '../features/visualizer/VisualizeRedirect';
import VisualizerWorkspace from '../features/visualizer/VisualizerWorkspace';

export default function App() {
  const [activeColor, setActiveColor] = useState(null); // hex string, drives the sidebar swatch rail

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <Sidebar activeColor={activeColor} />
      <main style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto', background: 'var(--paper)' }}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/projects" element={<ProjectsListPage />} />
          {/* The Visualizer is never a standalone destination — every canvas
              session is scoped to a project (requirements doc, Section 3). */}
          <Route path="/visualize" element={<VisualizeRedirect />} />
          <Route
            path="/projects/:projectId/visualize"
            element={<VisualizerWorkspace onColorFocus={setActiveColor} />}
          />
          <Route path="/catalog" element={<CatalogPage onColorFocus={setActiveColor} />} />
        </Routes>
      </main>
    </div>
  );
}
