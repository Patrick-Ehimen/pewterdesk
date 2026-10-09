// The landing site: four static pages in the editorial style, after the
// mockups in the local `design/landing/`. No venue calls, no keys, nothing
// from `@pewterdesk/ui`. Each page has its own index.html; this picks the
// page for the URL it was loaded from.
import { Layout } from "./components/Layout";
import { Download } from "./pages/Download";
import { Features } from "./pages/Features";
import { Home } from "./pages/Home";
import { Security } from "./pages/Security";
import { currentPage } from "./site";

const pages = { home: Home, features: Features, security: Security, download: Download };

export function App() {
  const page = currentPage();
  const Page = pages[page];
  return (
    <Layout page={page}>
      <Page />
    </Layout>
  );
}
