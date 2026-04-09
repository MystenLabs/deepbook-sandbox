const COIN_ICONS: Record<string, { src: string; className: string }> = {
    DEEP: { src: "/deepbook.jpeg", className: "h-4 w-4 rounded-full" },
    SUI: { src: "/svg/sui.svg", className: "h-4 w-4" },
    USDC: { src: "/svg/usdc.svg", className: "h-4 w-4 rounded-full" },
};

export function CoinIcon({ coin }: { coin: string }) {
    const icon = COIN_ICONS[coin];
    if (!icon) return null;
    return <img src={icon.src} alt={coin} className={icon.className} />;
}
