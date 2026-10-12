param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Protect', 'Unprotect', 'LockDirectory')]
    [string]$Mode,
    [string]$SecretDirectory
)

$ErrorActionPreference = 'Stop'
try {
    if ($Mode -eq 'LockDirectory') {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $acl = [System.Security.AccessControl.DirectorySecurity]::new()
        $acl.SetOwner($identity.User)
        $acl.SetAccessRuleProtection($true, $false)
        $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        $propagation = [System.Security.AccessControl.PropagationFlags]::None
        $allow = [System.Security.AccessControl.AccessControlType]::Allow
        foreach ($sid in @($identity.User, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
            $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid,
                [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow)
            $acl.AddAccessRule($rule)
        }
        # Use .NET directly: inherited PowerShell module paths may belong to a different runtime.
        [System.IO.DirectoryInfo]::new($SecretDirectory).SetAccessControl($acl)
        [Console]::Out.Write('OK')
        exit 0
    }

    [void][System.Reflection.Assembly]::LoadWithPartialName('System.Security')
    # Only the Node child process sees the pipe contents; never use command arguments for secrets.
    $payload = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($Mode -eq 'Protect') {
        $result = [System.Security.Cryptography.ProtectedData]::Protect($payload, $null, $scope)
    } else {
        $result = [System.Security.Cryptography.ProtectedData]::Unprotect($payload, $null, $scope)
    }
    [Console]::Out.Write([Convert]::ToBase64String($result))
    [Array]::Clear($payload, 0, $payload.Length)
    [Array]::Clear($result, 0, $result.Length)
} catch {
    # Crypto exception objects may contain credential inputs. Keep all failures generic.
    [Console]::Error.Write('Windows wallet protection failed in ' + $Mode + ' (' + $_.Exception.GetType().Name + ').')
    exit 1
}
