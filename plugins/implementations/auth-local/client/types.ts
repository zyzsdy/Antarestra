export interface UserRole {
  id: string
  name: string
  scope: string
  source: string
  expires_at: number | null
}
export interface User {
  id: string
  email: string
  principal_id: string
  principal: { display_name: string; status: string }
  roles: UserRole[]
}
export interface InitialCredentials {
  loginName: string
  displayName: string
  initialPassword: string
  loginUrl: string
}
export interface Roles {
  roles: { id: string; name: string }[]
  grants: { role_id: string; permission: string }[]
  permissions: { key: string; description: string; defaultRoles: string[] }[]
}
