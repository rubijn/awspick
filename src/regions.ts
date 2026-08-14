/**
 * Static region list. No `ec2:DescribeRegions` call — it needs credentials and
 * network, which defeats a sub-300 ms interactive tool (ADR-0001). Free-text
 * entry is always allowed, so a region missing from this list is never blocked.
 */

export const REGIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'us-east-1', label: 'US East (N. Virginia)' },
  { id: 'us-east-2', label: 'US East (Ohio)' },
  { id: 'us-west-1', label: 'US West (N. California)' },
  { id: 'us-west-2', label: 'US West (Oregon)' },
  { id: 'ca-central-1', label: 'Canada (Central)' },
  { id: 'ca-west-1', label: 'Canada West (Calgary)' },
  { id: 'eu-west-1', label: 'Europe (Ireland)' },
  { id: 'eu-west-2', label: 'Europe (London)' },
  { id: 'eu-west-3', label: 'Europe (Paris)' },
  { id: 'eu-central-1', label: 'Europe (Frankfurt)' },
  { id: 'eu-central-2', label: 'Europe (Zurich)' },
  { id: 'eu-north-1', label: 'Europe (Stockholm)' },
  { id: 'eu-south-1', label: 'Europe (Milan)' },
  { id: 'eu-south-2', label: 'Europe (Spain)' },
  { id: 'me-south-1', label: 'Middle East (Bahrain)' },
  { id: 'me-central-1', label: 'Middle East (UAE)' },
  { id: 'il-central-1', label: 'Israel (Tel Aviv)' },
  { id: 'af-south-1', label: 'Africa (Cape Town)' },
  { id: 'ap-east-1', label: 'Asia Pacific (Hong Kong)' },
  { id: 'ap-south-1', label: 'Asia Pacific (Mumbai)' },
  { id: 'ap-south-2', label: 'Asia Pacific (Hyderabad)' },
  { id: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
  { id: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
  { id: 'ap-southeast-3', label: 'Asia Pacific (Jakarta)' },
  { id: 'ap-southeast-4', label: 'Asia Pacific (Melbourne)' },
  { id: 'ap-southeast-5', label: 'Asia Pacific (Malaysia)' },
  { id: 'ap-southeast-7', label: 'Asia Pacific (Thailand)' },
  { id: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
  { id: 'ap-northeast-2', label: 'Asia Pacific (Seoul)' },
  { id: 'ap-northeast-3', label: 'Asia Pacific (Osaka)' },
  { id: 'sa-east-1', label: 'South America (São Paulo)' },
  { id: 'mx-central-1', label: 'Mexico (Central)' },
  { id: 'us-gov-east-1', label: 'AWS GovCloud (US-East)' },
  { id: 'us-gov-west-1', label: 'AWS GovCloud (US-West)' },
  { id: 'cn-north-1', label: 'China (Beijing)' },
  { id: 'cn-northwest-1', label: 'China (Ningxia)' },
];

const KNOWN = new Set(REGIONS.map((r) => r.id));

export function isKnownRegion(id: string): boolean {
  return KNOWN.has(id);
}

/** Loose shape check, so free text can be accepted without being nonsense. */
export function looksLikeRegion(value: string): boolean {
  return /^[a-z]{2}(-[a-z]+)+-\d+$/.test(value);
}

export function labelFor(id: string): string | undefined {
  return REGIONS.find((r) => r.id === id)?.label;
}
