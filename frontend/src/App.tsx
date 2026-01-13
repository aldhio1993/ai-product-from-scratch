import { BrowserRouter, Routes, Route } from 'react-router-dom';
import EditorView from './components/EditorView';
import LogsPage from './components/LogsPage';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<EditorView />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/logs/:sessionId" element={<LogsPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
