from __future__ import annotations

import base64
import io
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from PIL import Image, ImageDraw


class ChartPlotError(ValueError):
    pass


BASE_DIR = Path(__file__).resolve().parent


def load_template_library() -> dict[str, dict[str, Any]]:
    config_path = BASE_DIR / "growth_chart_config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    templates: dict[str, dict[str, Any]] = {}
    for chart in config["charts"]:
        data_key = chart.get("dataKey") or chart["metric"]
        plot_area = chart["plotArea"]
        templates[chart["templateKey"]] = {
            "chartId": chart["chartId"],
            "label": chart["label"],
            "referenceSource": chart["referenceSource"],
            "path": chart["backgroundImage"],
            "regions": {
                data_key: {
                    "chartId": chart["chartId"],
                    "referenceSource": chart["referenceSource"],
                    "metric": chart["metric"],
                    "x": {
                        "source": "ageMonths" if chart["xUnit"] == "months" else "ageYears",
                        "min": chart["xMin"],
                        "max": chart["xMax"],
                        "start": plot_area["left"],
                        "end": plot_area["right"],
                    },
                    "y": {
                        "source": data_key,
                        "min": chart["yMin"],
                        "max": chart["yMax"],
                        "start": plot_area["bottom"],
                        "end": plot_area["top"],
                    },
                }
            },
        }
    return templates


TEMPLATE_LIBRARY: dict[str, dict[str, Any]] = load_template_library()

MARKER_FILL = "#111111"
MARKER_OUTLINE = "#111111"


def parse_float(value: Any) -> float:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return float("nan")


def parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def get_age_years_at_date(dob_value: str, measured_at_value: Any) -> float:
    dob = parse_datetime(dob_value)
    measured_at = parse_datetime(measured_at_value)
    if dob is None or measured_at is None or measured_at < dob:
        return float("nan")
    return (measured_at - dob).total_seconds() / (365.25 * 24 * 60 * 60)


def clamp_ratio(value: float) -> float:
    return min(1.0, max(0.0, value))


def build_patient_data(dob_value: str, entry: dict[str, Any]) -> dict[str, float]:
    age_years = get_age_years_at_date(dob_value, entry.get("measuredAt"))
    age_months = age_years * 12 if age_years == age_years else float("nan")
    weight = parse_float(entry.get("weight"))
    height = parse_float(entry.get("height"))
    head = parse_float(entry.get("head"))
    bmi = weight / ((height / 100) ** 2) if height == height and weight == weight and height > 0 else float("nan")
    return {
        "ageYears": age_years,
        "ageMonths": age_months,
        "weight": weight,
        "height": height,
        "head": head,
        "bmi": bmi,
    }


def map_point(region: dict[str, Any], patient_data: dict[str, float], width: int, height: int) -> tuple[float, float] | None:
    x_value = patient_data.get(region["x"]["source"], float("nan"))
    y_value = patient_data.get(region["y"]["source"], float("nan"))
    if x_value != x_value or y_value != y_value:
        return None
    x_ratio = clamp_ratio((x_value - region["x"]["min"]) / (region["x"]["max"] - region["x"]["min"]))
    y_ratio = clamp_ratio((y_value - region["y"]["min"]) / (region["y"]["max"] - region["y"]["min"]))
    x = (region["x"]["start"] + (region["x"]["end"] - region["x"]["start"]) * x_ratio) * width
    y = (region["y"]["start"] - (region["y"]["start"] - region["y"]["end"]) * y_ratio) * height
    return x, y


def get_plot_bounds(region: dict[str, Any], width: int, height: int, inset: float = 0.0) -> tuple[float, float, float, float]:
    left = min(region["x"]["start"], region["x"]["end"]) * width + inset
    right = max(region["x"]["start"], region["x"]["end"]) * width - inset
    top = min(region["y"]["start"], region["y"]["end"]) * height + inset
    bottom = max(region["y"]["start"], region["y"]["end"]) * height - inset
    if left > right:
        midpoint_x = (left + right) / 2
        left = midpoint_x
        right = midpoint_x
    if top > bottom:
        midpoint_y = (top + bottom) / 2
        top = midpoint_y
        bottom = midpoint_y
    return left, right, top, bottom


def constrain_point_to_bounds(point: tuple[float, float], bounds: tuple[float, float, float, float]) -> tuple[float, float]:
    left, right, top, bottom = bounds
    x, y = point
    return min(max(x, left), right), min(max(y, top), bottom)


def clip_overlay_to_bounds(
    overlay: Image.Image,
    width: int,
    height: int,
    bounds: tuple[float, float, float, float],
) -> Image.Image:
    left, right, top, bottom = bounds
    clipped_overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    mask = Image.new("L", (width, height), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rectangle((left, top, right, bottom), fill=255)
    clipped_overlay.paste(overlay, (0, 0), mask)
    return clipped_overlay


def soften_chart_background(image: Image.Image) -> Image.Image:
    softened = image.copy()
    pixels = softened.load()
    width, height = softened.size

    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            if red > 238 and green > 238 and blue > 238:
                pixels[x, y] = (255, 255, 255, alpha)

    return softened


def sort_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(entries, key=lambda entry: parse_datetime(entry.get("measuredAt")) or datetime.min)


def get_marker_metrics(image_width: int) -> tuple[int, int]:
    radius = max(8, round(image_width * 0.005))
    outline_width = 0
    return radius, outline_width


def draw_marker(draw: ImageDraw.ImageDraw, point: tuple[float, float], image_width: int) -> None:
    radius, outline_width = get_marker_metrics(image_width)
    x, y = point
    draw.ellipse(
        (x - radius, y - radius, x + radius, y + radius),
        fill=MARKER_FILL,
        outline=MARKER_OUTLINE if outline_width else None,
        width=outline_width,
    )


def render_template_page(template_request: dict[str, Any], plot_series: dict[str, list[dict[str, Any]]], dob_value: str) -> Image.Image:
    template_key = template_request.get("key", "")
    template = TEMPLATE_LIBRARY.get(template_key)
    if not template:
        raise ChartPlotError(f"Unknown template key: {template_key}")

    image_path = BASE_DIR / template["path"]
    if not image_path.exists():
        raise ChartPlotError(f"Missing chart asset: {template['path']}")

    image = soften_chart_background(Image.open(image_path).convert("RGBA"))
    line_width = max(3, round(image.width * 0.002))
    marker_radius, _ = get_marker_metrics(image.width)

    for metric_key in template_request.get("metrics", []):
        region = template["regions"].get(metric_key)
        if not region:
            continue

        plot_bounds = get_plot_bounds(region, image.width, image.height, max(marker_radius, line_width / 2))
        clip_bounds = get_plot_bounds(region, image.width, image.height, 0)
        entries = sort_entries(list(plot_series.get(metric_key, [])))
        mapped_points = []
        for entry in entries:
            patient_data = build_patient_data(dob_value, entry)
            if patient_data.get(metric_key) != patient_data.get(metric_key):
                continue
            point = map_point(region, patient_data, image.width, image.height)
            if point is not None:
                mapped_points.append(constrain_point_to_bounds(point, plot_bounds))

        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        overlay_draw = ImageDraw.Draw(overlay)
        if len(mapped_points) > 1:
            overlay_draw.line(mapped_points, fill=MARKER_FILL, width=line_width, joint="curve")

        for point in mapped_points:
            draw_marker(overlay_draw, point, image.width)

        image = Image.alpha_composite(image, clip_overlay_to_bounds(overlay, image.width, image.height, clip_bounds))

    return image.convert("RGB")


def encode_png_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def encode_pdf_base64(images: list[Image.Image]) -> str:
    if not images:
        return ""
    pdf_buffer = io.BytesIO()
    first_image, *remaining = [image.convert("RGB") for image in images]
    first_image.save(pdf_buffer, format="PDF", save_all=True, append_images=remaining)
    return base64.b64encode(pdf_buffer.getvalue()).decode("ascii")


def generate_chart_package(
    payload: dict[str, Any],
    *,
    template_filter: Callable[[str], bool] | None = None,
    filter_label: str = "the requested charts",
) -> dict[str, Any]:
    dob_value = str(payload.get("dob", "")).strip()
    if not dob_value:
        raise ChartPlotError("DOB is required for chart plotting.")

    template_requests = payload.get("templateRequests")
    if not isinstance(template_requests, list) or not template_requests:
        raise ChartPlotError("No chart templates were requested.")

    plot_series = payload.get("plotSeries")
    if not isinstance(plot_series, dict):
        raise ChartPlotError("Plot series payload is missing.")

    pages = []
    page_images = []

    for template_request in template_requests:
        template_key = str(template_request.get("key", "")).strip()
        if template_key not in TEMPLATE_LIBRARY:
            raise ChartPlotError(f"Unknown template key: {template_key or 'missing'}")
        if template_filter and not template_filter(template_key):
            raise ChartPlotError(f"This endpoint supports only {filter_label}.")

        image = render_template_page(template_request, plot_series, dob_value)
        pages.append(
            {
                "label": template_request.get("label") or TEMPLATE_LIBRARY[template_key]["label"],
                "dataUrl": encode_png_data_url(image),
                "width": image.width,
                "height": image.height,
            }
        )
        page_images.append(image)

    return {
        "pages": pages,
        "pdfBase64": encode_pdf_base64(page_images),
    }
