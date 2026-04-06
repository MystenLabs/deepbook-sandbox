import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SuiClientProvider } from "@mysten/dapp-kit";
import { createNetworkConfig } from "@mysten/dapp-kit";
import "./index.css";
import App from "./App.tsx";

const { networkConfig } = createNetworkConfig({
    localnet: { network: "localnet", url: "http://localhost:9000" },
});

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <SuiClientProvider networks={networkConfig} defaultNetwork="localnet">
                <App />
            </SuiClientProvider>
        </QueryClientProvider>
    </StrictMode>,
);
