import Foundation
import Security

enum Keychain {
    static func read(server: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: "Tasks", kSecAttrAccount as String: server,
          kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ token: String?, server: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: "Tasks", kSecAttrAccount as String: server]
        SecItemDelete(query as CFDictionary)
        guard let token else { return }
        var entry = query
        entry[kSecValueData as String] = Data(token.utf8)
        entry[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(entry as CFDictionary, nil)
        guard status == errSecSuccess else { throw APIError(message: "Could not securely save your session (\(status)).") }
    }
}
struct APIError: LocalizedError {
    let message: String
    var status: Int? = nil
    /// The server no longer accepts this session, so signing in again is the only way forward.
    var sessionEnded = false
    var errorDescription: String? { message }
}
struct API {
    var server: String
    var token: String?
    func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        let data = try await send(path, method: method, body: body)
        return try JSONDecoder().decode(T.self, from: data)
    }
    @discardableResult
    func send(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        guard let url = URL(string: server + path), let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? ""))
        else { throw APIError(message: "Use your HTTPS server URL, or localhost for development.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError(message: "The server did not respond.") }
        guard (200...299).contains(http.statusCode) else {
            let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["detail"] as? String
            // Apple's sign-in routes also answer 401, which means that attempt failed rather than the session.
            throw APIError(message: detail ?? "Request failed (\(http.statusCode)). Please try again.", status: http.statusCode,
                           sessionEnded: http.statusCode == 401 && !path.hasPrefix("/auth/apple/"))
        }
        return data
    }
    static func body(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
}
