const env = import.meta.env as unknown as Record<string, string | undefined>;

function text(name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

export const legalConfig = {
  providerName: text("VITE_LEGAL_PROVIDER_NAME", "[Full legal name or company name]"),
  providerAddress: text("VITE_LEGAL_PROVIDER_ADDRESS", "[Street and house number, ZIP city, country]"),
  providerEmail: text("VITE_LEGAL_PROVIDER_EMAIL", "[contact email address]"),
  representedBy: text("VITE_LEGAL_REPRESENTED_BY", "[Representative, if applicable]"),
  vatId: text("VITE_LEGAL_VAT_ID", "[VAT identification number, if applicable]"),
  contentResponsible: text("VITE_LEGAL_CONTENT_RESPONSIBLE", "[name and address, if applicable]"),
  dataProtectionOfficer: text("VITE_LEGAL_DPO", "[Data protection officer contact details, if legally required]"),
  hostingProvider: text("VITE_LEGAL_HOSTING_PROVIDER", "[hosting provider name and contact details]"),
  hostingRegion: text("VITE_LEGAL_HOSTING_REGION", "[hosting region/country]"),
  hostingDpa: text("VITE_LEGAL_HOSTING_DPA", "[data processing agreement status]"),
  logRetention: text("VITE_LEGAL_LOG_RETENTION", "[technical log retention period]"),
  accountRetention: text("VITE_LEGAL_ACCOUNT_RETENTION", "[guest account and match statistic retention period]")
};

export const hasPlaceholderLegalConfig = Object.values(legalConfig).some(
  (value) => value.startsWith("[") && value.endsWith("]")
);
