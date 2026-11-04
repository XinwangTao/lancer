import { createElement } from "react";
import { ModelIcon } from "./icons";
import { MODEL_BRAND_MARKS } from "./model-brand-marks";
import { modelFamily } from "./model-families";

export function ModelBrandIcon({
  provider,
  modelId,
  mark,
}: {
  readonly provider?: string;
  readonly modelId?: string;
  /** Brand mark to draw when the caller is not a model provider (companion apps). */
  readonly mark?: string;
}) {
  const brand = mark ?? modelFamily(provider, modelId)?.id;
  const icon = brand ? MODEL_BRAND_MARKS[brand] : undefined;
  if (!icon) return <ModelIcon />;
  return (
    <svg {...icon.attributes} aria-hidden="true">
      {icon.parts.map((part, key) => createElement(part.tag, { ...part.attributes, key }))}
    </svg>
  );
}
