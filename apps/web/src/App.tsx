import { Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './components/Shell';
import { LikedSongsView } from './views/LikedSongsView';
import { ProfileView } from './views/ProfileView';
import { SearchView } from './views/SearchView';

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<SearchView />} />
        <Route path="/liked" element={<LikedSongsView />} />
        <Route path="/profile" element={<ProfileView />} />
        <Route path="/auth" element={<Navigate to="/profile" replace />} />
      </Route>
    </Routes>
  );
}
