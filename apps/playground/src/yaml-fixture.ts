export const plainYaml = `# Chart configuration
apiVersion: v2
name: worker
version: "1.0.0"
replicas: 2
enabled: true
labels: {app: worker, tier: backend}
ports: [80, 443]
description: |
  A background worker.
  Keeps its configuration readable.
---
optional: null
`;

export const helmYaml = `{{- if not (has .Values.mode (list "identity" "rollout")) -}}
{{- fail "mode must be identity or rollout" -}}
{{- end -}}
# Render a service account
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .Release.Name }}
  namespace: "{{ .Release.Namespace }}"
automountServiceAccountToken: true
---
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ printf "%s-check" .Release.Name | quote }}
spec:
  backoffLimit: 2
  activeDeadlineSeconds: {{ add (int .Values.timeoutSeconds) 30 }}
  args: [{{ .Values.mode | quote }}, "ready"]
  message: |
    Hello {{ .Release.Name }}!
    This remains a YAML block scalar.
{{- if eq .Values.mode "identity" }}
  enabled: true
{{- else }}
  enabled: false
{{- end }}
`;
