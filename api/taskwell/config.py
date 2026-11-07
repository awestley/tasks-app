from urllib.parse import urlsplit

from pydantic import field_validator
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
    # Comma-separated Apple subjects or verified email addresses that may sign in. Required in production,
    # unless the shell handles sign in.
    allowed_apple_accounts: str = ""
    # Header a trusted proxy sets to the client's address, such as x-forwarded-for or do-connecting-ip.
    client_ip_header: str = ""

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

    @field_validator("public_url", "shell_url")
    @classmethod
    def origin_without_trailing_slash(cls, value):
        # Browsers send Origin without one, so a trailing slash would fail every cookie write.
        return value.rstrip("/")

    @property
    def native_client_ids(self):
        return [value.strip() for value in self.apple_native_client_ids.split(",") if value.strip()]

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

    @property
    def apple_account_allowlist(self):
        return {value.strip().lower() for value in self.allowed_apple_accounts.split(",") if value.strip()}

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
            if urlsplit(self.public_url).path:
                raise RuntimeError("PUBLIC_URL must be an origin, without a path")
            if self.shell_mode:
                if not self.shell_url.startswith("https://") or self.public_url != self.shell_url:
                    raise RuntimeError("Production in the shell requires an HTTPS SHELL_URL equal to PUBLIC_URL")
                if not self.base_path.startswith("/apps/"):
                    raise RuntimeError("Production in the shell requires BASE_PATH, such as /apps/tasks")
            else:
                # The shell decides who can sign in. On its own, this server has to.
                if self.apple_base_url != "https://appleid.apple.com" or not self.apple_ready:
                    raise RuntimeError("Production requires configured Sign in with Apple")
                if not self.apple_account_allowlist or "REPLACE" in self.allowed_apple_accounts:
                    raise RuntimeError("Production requires ALLOWED_APPLE_ACCOUNTS so only your accounts can sign in")


settings = Settings()
settings.base_path = settings.base_path.rstrip("/")
settings.validate_production()
