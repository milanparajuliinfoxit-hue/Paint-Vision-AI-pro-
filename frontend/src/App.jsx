import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import CatalogPage from './pages/CatalogPage';
import VisualizerPage from './pages/VisualizerPage';

export default function App() {
  const [activeColor, setActiveColor] = useState(null); // hex string, drives the swatch rail

  return (
    <div style={{ display: 'flex' }}>
      <Sidebar activeColor={activeColor} />
      <main style={{ flex: 1, background: 'var(--paper)', minHeight: '100vh' }}>
        <Routes>
          <Route path="/" element={<Navigate to="/catalog" replace />} />
          <Route path="/catalog" element={<CatalogPage onColorFocus={setActiveColor} />} />
          <Route path="/visualizer" element={<VisualizerPage onColorFocus={setActiveColor} />} />
        </Routes>
      </main>
    </div>
  );
}
