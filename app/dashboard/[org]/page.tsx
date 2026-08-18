export default async function OrgOverviewPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Overview</h1>
      <p className="text-gray-600">
        Welcome to <span className="font-medium">{org}</span>. Connect a Shopify store to get
        started generating a theme.
      </p>
    </div>
  );
}
