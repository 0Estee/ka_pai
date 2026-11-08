// 光球本体：球面衰减 + 极坐标能量流 + 边缘环光，加色叠加到渐变光环之上。
// quality=0 时只算一层噪声（省电/低端机）；energy 由 KPOrb.pulse() 驱动做「吸一口气」。
shader_type canvas_item;
render_mode blend_add, unshaded;

uniform vec4 core_color : source_color = vec4(1.0, 0.96, 0.86, 1.0);
uniform vec4 rim_color : source_color = vec4(1.0, 0.76, 0.29, 1.0);
uniform float time = 0.0;
uniform float energy = 1.0;
uniform float glow = 1.0;
uniform float quality = 1.0;

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float vnoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	float a = hash(i);
	float b = hash(i + vec2(1.0, 0.0));
	float c = hash(i + vec2(0.0, 1.0));
	float d = hash(i + vec2(1.0, 1.0));
	return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
	float v = 0.0;
	float amp = 0.55;
	for (int i = 0; i < 3; i++) {
		v += vnoise(p) * amp;
		p = p * 2.03 + vec2(1.7, 9.2);
		amp *= 0.5;
		if (quality < 0.5 && i == 0) {
			break;
		}
	}
	return v;
}

void fragment() {
	vec2 uv = UV * 2.0 - 1.0;
	float d = length(uv) * 2.0;              // 1.0 = 光球半径
	float mask = smoothstep(1.0, 0.32, d);

	// 一层慢慢翻卷的云 + 一层更细的流丝，越靠外越亮（边缘环光）
	float swirl = fbm(uv * 3.1 + vec2(time * 0.16, -time * 0.23));
	float thread = fbm(uv * 7.2 - vec2(time * 0.34, time * 0.26));
	float drift = fbm(uv * 4.6 + vec2(-time * 0.27, time * 0.19));
	float core = smoothstep(0.55, 0.0, d);
	float rim = smoothstep(0.40, 0.90, d) * smoothstep(1.0, 0.84, d);

	// 能量丝：把 fbm 做成「脊」——只有接近中值的地方亮起来，形成绕球的细流线
	// （直接阈值化 fbm 会得到一片糊的斑块，脊化之后才像流动的光丝）
	float ridge = 1.0 - abs(swirl * 2.0 - 1.0);
	ridge = pow(clamp(ridge, 0.0, 1.0), 14.0);
	float ridge2 = 1.0 - abs(thread * 2.0 - 1.0);
	ridge2 = pow(clamp(ridge2, 0.0, 1.0), 6.0);
	// 第二股反向慢流，两股交叠才有「绕着球翻卷」的层次
	float ridge3 = 1.0 - abs(drift * 2.0 - 1.0);
	ridge3 = pow(clamp(ridge3, 0.0, 1.0), 11.0) * 0.65;
	// 越靠外越亮；最中心留一处白热点，不铺丝
	float band = smoothstep(0.12, 0.72, d) * smoothstep(1.0, 0.55, d);
	float vein = (ridge * (0.30 + 0.70 * ridge2) + ridge3) * band;

	vec3 col = core_color.rgb * (core * 0.62)
	         + mix(core_color.rgb, rim_color.rgb, smoothstep(0.15, 0.95, d)) * vein * 3.1
	         + rim_color.rgb * rim * 0.95;

	float breathe = 0.88 + 0.12 * sin(time * 1.45);
	float a = mask * (0.42 + 0.30 * energy) * glow * breathe;
	COLOR = vec4(col * mask, clamp(a, 0.0, 1.0));
}
