import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { ConnectButton } from "@mysten/dapp-kit";
import { cn } from "@/lib/utils";
import { RequireWallet } from "@/components/require-wallet";
import { FaucetPage } from "@/components/faucet-page";
import { HealthPage } from "@/components/health-page";

const navLinks = [
    { to: "/", label: "Health" },
    { to: "/pools", label: "Pools" },
    { to: "/faucet", label: "Faucet" },
] as const;

function Layout({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen bg-background text-foreground">
            <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-md ring-1 ring-border/50">
                <div className="mx-auto flex h-16 max-w-7xl items-center px-6">
                    {/* Logo */}
                    <NavLink to="/" className="flex items-center gap-2.5">
                        <img src="/deepbook.jpeg" alt="DeepBook" className="h-7 w-7 rounded-full" />
                        <svg height="28" viewBox="0 0 24 24" width="28" className="text-border">
                            <path
                                d="M16 3.5L8 20.5"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                        <span className="text-base font-semibold tracking-tight">
                            DeepBook Sandbox
                        </span>
                    </NavLink>

                    {/* Nav */}
                    <nav className="ml-8 flex items-center gap-1">
                        {navLinks.map((l) => (
                            <NavLink
                                key={l.to}
                                to={l.to}
                                end={l.to === "/"}
                                className={({ isActive }) =>
                                    cn(
                                        "rounded-md px-3.5 py-2 text-base transition-colors",
                                        isActive
                                            ? "bg-accent text-foreground"
                                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                                    )
                                }
                            >
                                {l.label}
                            </NavLink>
                        ))}
                    </nav>

                    {/* Right */}
                    <div className="ml-auto">
                        <ConnectButton />
                    </div>
                </div>
            </header>
            <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
        </div>
    );
}

function Placeholder({ title }: { title: string }) {
    return (
        <div className="rounded-lg border bg-card p-6 text-card-foreground">
            <h1 className="text-lg font-semibold">{title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">Coming soon.</p>
        </div>
    );
}

export default function App() {
    return (
        <BrowserRouter>
            <Layout>
                <Routes>
                    <Route path="/" element={<HealthPage />} />
                    <Route path="/pools" element={<Placeholder title="Pools" />} />
                    <Route path="/pool/:poolName" element={<Placeholder title="Pool Detail" />} />
                    <Route
                        path="/faucet"
                        element={
                            <RequireWallet>
                                <FaucetPage />
                            </RequireWallet>
                        }
                    />
                </Routes>
            </Layout>
        </BrowserRouter>
    );
}
