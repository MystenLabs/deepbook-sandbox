import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { ConnectButton } from "@mysten/dapp-kit";
import { cn } from "@/lib/utils";

const navLinks = [
    { to: "/", label: "Health" },
    { to: "/pools", label: "Pools" },
    { to: "/faucet", label: "Faucet" },
] as const;

function Layout({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen bg-background text-foreground">
            <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
                <div className="mx-auto flex h-12 max-w-7xl items-center gap-6 px-4">
                    <span className="text-sm font-bold tracking-tight">DeepBook</span>
                    <nav className="flex gap-4">
                        {navLinks.map((l) => (
                            <NavLink
                                key={l.to}
                                to={l.to}
                                end={l.to === "/"}
                                className={({ isActive }) =>
                                    cn(
                                        "text-sm transition-colors hover:text-foreground",
                                        isActive ? "text-foreground" : "text-muted-foreground",
                                    )
                                }
                            >
                                {l.label}
                            </NavLink>
                        ))}
                    </nav>
                    <div className="ml-auto">
                        <ConnectButton />
                    </div>
                </div>
            </header>
            <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
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
                    <Route path="/" element={<Placeholder title="Service Health" />} />
                    <Route path="/pools" element={<Placeholder title="Pools" />} />
                    <Route path="/pool/:poolName" element={<Placeholder title="Pool Detail" />} />
                    <Route path="/faucet" element={<Placeholder title="Faucet" />} />
                </Routes>
            </Layout>
        </BrowserRouter>
    );
}
