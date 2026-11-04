from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    environment: str = "development"
    database_url: str = "sqlite:///./taskwell.db"
    public_url: str = "http://localhost:5173"
    secret_key: str = "local-development-only-key-do-not-deploy"
    dev_login: bool = False
    apple_team_id: str = ""
    apple_key_id: str = ""
    apple_private_key: str = ""
    apple_web_client_id: str = ""
    apple_native_client_ids: str = ""
    apple_base_url: str = "https://appleid.apple.com"
    static_directory: str = "../web/dist"

    # Personal Command: when SHELL_URL is set, the app runs inside the shell at that origin. People sign
    # in through the shell, and this API verifies the shell's tokens instead of running its own sign in.
    shell_url: str = ""
    shell_jwks_url: str = ""
    base_path: str = ""

    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = ""
    apns_team_id: str = ""
    apns_key_id: str = ""
    apns_private_key: str = ""
    push_simulation_url: str = ""

    @property
    def production(self):
        return self.environment == "production"

    @property
    def shell_mode(self):
        return bool(self.shell_url)

    @property
    def jwks_url(self):
        return self.shell_jwks_url or self.shell_url.rstrip("/") + "/auth/.well-known/jwks.json"

    @property
    def apple_ready(self):
        return bool(self.apple_team_id and self.apple_key_id and self.apple_private_key and self.apple_web_client_id)

    def validate_production(self):
        if self.production:
            if self.push_simulation_url:
                raise RuntimeError("Push simulation is forbidden in production")
            if (
                self.dev_login
                or len(self.secret_key) < 32
                or self.secret_key.startswith("local-")
                or "REPLACE" in self.secret_key
            ):
                raise RuntimeError("Production requires a strong SECRET_KEY and DEV_LOGIN=false")
            if not self.public_url.startswith("https://") or not self.database_url.startswith("postgres"):
                raise RuntimeError("Production requires HTTPS PUBLIC_URL and PostgreSQL DATABASE_URL")
            if self.shell_mode:
                if not self.shell_url.startswith("https://") or self.public_url != self.shell_url:
                    raise RuntimeError("Production in the shell requires an HTTPS SHELL_URL equal to PUBLIC_URL")
                if not self.base_path.startswith("/apps/"):
                    raise RuntimeError("Production in the shell requires BASE_PATH, such as /apps/tasks")
            elif self.apple_base_url != "https://appleid.apple.com" or not self.apple_ready:
                raise RuntimeError("Production requires configured Sign in with Apple")


settings = Settings()
settings.base_path = settings.base_path.rstrip("/")
settings.validate_production()
