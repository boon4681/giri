export class RouteResponseSchemaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RouteResponseSchemaError';
    }
}
