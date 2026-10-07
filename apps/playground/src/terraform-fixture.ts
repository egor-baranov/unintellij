import type { Fixture } from './fixtures';

const source = [
  '# Terraform infrastructure configuration',
  'terraform {',
  '  required_version = ">= 1.11.0"',
  '}',
  '',
  'variable "region" {',
  '  type    = string',
  '  default = "eu-west-1"',
  '}',
  '',
  'resource "example_worker" "api" {',
  '  count   = 2',
  '  enabled = true',
  '  name    = "api-${var.region}"',
  '  tags    = merge({ service = "api" }, { managed = true })',
  '',
  '  /* Configuration shared',
  '     across worker instances. */',
  '  description = <<-EOT',
  '    Managed worker deployment',
  '  EOT',
  '}',
  '',
].join('\n');

export const terraformFixture: Fixture = {
  id: 'terraform', name: 'Terraform configuration', path: 'terraform/main.tf',
  original: source, modified: source.replace('count   = 2', 'count   = 3').replace('enabled = true', 'enabled = false'),
  description: 'HCL blocks, expressions, comments, strings, interpolation, and heredocs use the shared host tokenizer.',
};
