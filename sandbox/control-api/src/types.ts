export interface ServiceInfo {
    name: string;
    status: "running" | "stopped" | "error" | "unknown";
    uptime?: string;
    ports?: string[];
    image?: string;
}

export interface ServiceListResponse {
    services: ServiceInfo[];
}

export interface ServiceActionResponse {
    success: boolean;
    message: string;
    service: string;
}

export interface LogsResponse {
    logs: string;
    service: string;
    lines: number;
}

export interface ConfigResponse {
    content: string;
}

export interface ConfigUpdateRequest {
    content: string;
}

export interface ResetResponse {
    success: boolean;
    message: string;
}

export interface AuditLogEntry {
    timestamp: string;
    action: string;
    service?: string;
    user?: string;
    success: boolean;
    message?: string;
}
