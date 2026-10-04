import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import PwaInstall from "./components/PwaInstall";
import AuthGate from "./auth/AuthGate";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <PwaInstall />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<AuthGate />} />
          <Route path="/super-admin/*" element={<AuthGate />} />
          <Route path="/stores" element={<AuthGate />} />
          <Route path="/stores/:storeId" element={<AuthGate />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
