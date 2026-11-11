import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { ClipResultsPage } from './pages/ClipResultsPage'
import { CreateProjectPage } from './pages/CreateProjectPage'
import { DashboardPage } from './pages/DashboardPage'
import { ProcessingPage } from './pages/ProcessingPage'
import { VideoEditorPage } from './pages/VideoEditorPage'

export function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/create" element={<CreateProjectPage />} />
          <Route path="/projects/:id/processing" element={<ProcessingPage />} />
          <Route path="/projects/:id/clips" element={<ClipResultsPage />} />
          <Route path="/clips/:id/edit" element={<VideoEditorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}

export default App

