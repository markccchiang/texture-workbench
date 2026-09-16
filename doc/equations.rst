Texture Feature Equations
=========================

This page lists the equations exactly as they are implemented in the C++ core: ``core/analysis/TextureAnalysis.cpp``
(the co-occurrence features), ``FirstOrder.cpp``, ``RunLength.cpp``, ``SizeZone.cpp``, ``GrayToneDifference.cpp``,
``LocalBinaryPattern.cpp`` and ``Shape.cpp``. Where the implementation differs from the usual literature definition, the difference is
noted.

Every feature is returned as a ``glcm::Features`` value with one field per direction: ``H``, ``V``, ``LD`` and ``RD``.
Co-occurrence and run length features are computed separately for each direction; first-order statistics and the size
zone, gray tone difference, local binary pattern and shape features have no direction and repeat the same value. The
directions setting (``glcm::TextureOptions`` in ``TextureAnalysis``) can restrict the directions; the others then hold
NaN. ``Features::Avg()`` and ``Features::Range()`` are the mean and the range (maximum − minimum) over the computed
directions.

.. contents:: On this page
   :local:
   :depth: 2

Co-occurrence matrix
--------------------

Region and directions
~~~~~~~~~~~~~~~~~~~~~

Let :math:`I` be an 8-bit grayscale image, :math:`\Omega` the selected region, and :math:`d \ge 1` the neighborhood
distance. In rectangle mode :math:`\Omega` is the whole cropped image; in polygon mode it is the set of pixels whose
mask value is 255.

Each direction :math:`\theta` has two neighbor offsets (row, column):

.. list-table::
   :header-rows: 1
   :widths: 15 15 40

   * - Direction
     - Name in code
     - Offsets :math:`(\Delta r, \Delta c)`
   * - 0°
     - ``H``
     - :math:`(0, d)` and :math:`(0, -d)`
   * - 90°
     - ``V``
     - :math:`(d, 0)` and :math:`(-d, 0)`
   * - 135°
     - ``LD``
     - :math:`(d, d)` and :math:`(-d, -d)`
   * - 45°
     - ``RD``
     - :math:`(d, -d)` and :math:`(-d, d)`

Gray levels are **zero-based**: :math:`i, j \in \{0, 1, \dots, N_g - 1\}`, where :math:`N_g` is the number of gray
levels (256 in the application). Haralick's paper [Haralick1973]_ numbers gray levels from 1, so features that
depend on the gray level values themselves (means, correlations, sum average, cluster shade and prominence,
auto correlation) are shifted compared with a one-based implementation.

ROI masks
~~~~~~~~~

Pixel :math:`(c, r)` (column, row) covers the square :math:`[c, c + 1) \times [r, r + 1)` in image coordinates, so its
centre is :math:`(c + 0.5, r + 0.5)`. A pixel belongs to an ROI when its centre lies inside the shape
(``glcm::RasterizeMask``):

- **Rectangle** :math:`(x, y, w, h)`: :math:`x \le c + 0.5 < x + w` and :math:`y \le r + 0.5 < y + h`.
- **Ellipse** with centre :math:`(c_x, c_y)`, semi-axes :math:`r_x, r_y` and rotation :math:`\theta` (clockwise on
  screen): with :math:`d_x = c + 0.5 - c_x` and :math:`d_y = r + 0.5 - c_y`,

  .. math::

     u = d_x \cos\theta + d_y \sin\theta, \quad v = -d_x \sin\theta + d_y \cos\theta, \qquad
     \frac{u^2}{r_x^2} + \frac{v^2}{r_y^2} \le 1

- **Polygon**: even-odd rule along the horizontal line through the pixel centres of each row. An edge from
  :math:`(x_a, y_a)` to :math:`(x_b, y_b)` crosses that line when :math:`\min(y_a, y_b) \le r + 0.5 < \max(y_a, y_b)`.

Shapes are clipped to the image.

Gray-level quantization
~~~~~~~~~~~~~~~~~~~~~~~

In the analysis pipeline (``glcm::RunAnalysis``), the intensities :math:`v` inside the ROI are first mapped to gray
levels :math:`i \in \{0, \dots, N_g - 1\}` (``glcm::Quantize``):

- **Fixed range** :math:`[a, b]`: :math:`i = \min\left(N_g - 1, \left\lfloor \dfrac{(v - a)\, N_g}{b - a + 1} \right\rfloor\right)`
  for :math:`v > a`, and :math:`i = 0` otherwise.
- **ROI min–max**: a fixed range whose :math:`a` and :math:`b` are the minimum and maximum inside the ROI.
- **Fixed bin width** :math:`w`: :math:`i = \lfloor (v - a) / w \rfloor` with :math:`a` the ROI minimum. The ROI must not
  need more than :math:`N_g` levels.
- **None**: :math:`i = v`; every value must be below :math:`N_g`.

The default for 8-bit images is a fixed range :math:`[0, 255]`, so :math:`N_g = 256` keeps the values unchanged and
:math:`N_g = 32` gives :math:`i = \lfloor v / 8 \rfloor`. For 16-bit images the default range is :math:`[0, 65535]`.

Counting pixel pairs
~~~~~~~~~~~~~~~~~~~~

For a central pixel :math:`(m, n)` and a neighbor :math:`(k, l) = (m + \Delta r, n + \Delta c)`, the pair is counted
only if **both** pixels are inside the image and inside :math:`\Omega`:

.. math::

   P_\theta(i, j) = \#\left\{ \big((m, n), (k, l)\big) \;:\;
      (m, n) \in \Omega,\ (k, l) \in \Omega,\ (\Delta r, \Delta c) \in \text{offsets}(\theta),\
      I(k, l) = i,\ I(m, n) = j \right\}

Because both offsets of a direction are visited from every central pixel, each unordered pixel pair is counted twice,
once as :math:`(i, j)` and once as :math:`(j, i)`, so :math:`P_\theta` is symmetric.

The normalization factor and the normalized matrix are

.. math::

   R_\theta = \sum_{i=0}^{N_g-1} \sum_{j=0}^{N_g-1} P_\theta(i, j), \qquad
   p(i, j) = \begin{cases}
      P_\theta(i, j) / R_\theta & R_\theta > 0 \\
      0 & R_\theta = 0
   \end{cases}

A direction without any pixel pair (for example 90° in a one-row region) therefore gives an all-zero matrix instead of
NaN values.

In the rest of this page :math:`p(i, j)` denotes the normalized matrix of one direction, and :math:`\sum_{i,j}` means
:math:`\sum_{i=0}^{N_g-1} \sum_{j=0}^{N_g-1}`.

Worked example
~~~~~~~~~~~~~~

For the 4 × 4 image with 4 gray levels from [Haralick1973]_

.. code-block:: text

   0 0 1 1
   0 0 1 1
   0 2 2 2
   2 2 3 3

the 0° matrix at distance 1 is

.. math::

   P_{0^\circ} = \begin{pmatrix}
      4 & 2 & 1 & 0 \\
      2 & 4 & 0 & 0 \\
      1 & 0 & 6 & 1 \\
      0 & 0 & 1 & 2
   \end{pmatrix}, \qquad R_{0^\circ} = 24

This example is checked by the unit test ``TextureAnalysisTest.HaralickExampleHorizontal``.

Marginal probabilities and statistics
-------------------------------------

These are computed once per direction in ``TextureAnalysis::Normalize()``.

.. math::

   p_x(i) = \sum_{j=0}^{N_g-1} p(i, j), \qquad
   p_y(j) = \sum_{i=0}^{N_g-1} p(i, j)

.. math::

   p_{x+y}(k) = \sum_{\substack{i,j \\ i + j = k}} p(i, j), \quad k = 0, \dots, 2N_g - 2
   \qquad
   p_{x-y}(k) = \sum_{\substack{i,j \\ |i - j| = k}} p(i, j), \quad k = 0, \dots, N_g - 1

Means and standard deviations from the marginal vectors:

.. math::

   \mu_x = \sum_{i} i \, p_x(i), \quad
   \mu_y = \sum_{j} j \, p_y(j), \quad
   \sigma_x = \sqrt{\sum_{i} (i - \mu_x)^2 \, p_x(i)}, \quad
   \sigma_y = \sqrt{\sum_{j} (j - \mu_y)^2 \, p_y(j)}

The same statistics summed directly over :math:`p(i, j)`. They are mathematically equal to the ones above and are used
only by the "another way" cross-check features:

.. math::

   \mu_i = \sum_{i,j} i \, p(i, j), \quad
   \mu_j = \sum_{i,j} j \, p(i, j), \quad
   \sigma_i = \sqrt{\sum_{i,j} (i - \mu_i)^2 \, p(i, j)}, \quad
   \sigma_j = \sqrt{\sum_{i,j} (j - \mu_j)^2 \, p(i, j)}

Entropies use the natural logarithm by default (``TextureOptions::log_base`` can select :math:`\log_2`, which scales
Entropy, Sum Entropy, Difference Entropy and the entropies inside IMC1 and IMC2), and terms whose probability is zero
are skipped (:math:`0 \log 0 = 0`).

Features
--------

Each entry starts with the feature's ``glcm::Type`` value, which is also its id in the API and in exported files. The
co-occurrence features are computed by ``TextureAnalysis::Calculate()``, the other families by the functions named in
their sections.

.. _region-statistics:

First-order statistics
~~~~~~~~~~~~~~~~~~~~~~

These do not use the co-occurrence matrix. The same value is reported for every computed direction. Let
:math:`v_1, \dots, v_N` be the values of the :math:`N` pixels in :math:`\Omega` and :math:`v_{(1)} \le \dots \le v_{(N)}`
the same values sorted. The analysis pipeline uses the original intensities (before quantization) for all of them except
``FirstOrderEntropy`` and ``Uniformity``, which use the quantized gray levels. ``TextureAnalysis`` on its own computes
only ``Mean`` and ``Std``, from the gray levels it is given; the others are computed by ``ComputeFirstOrderStatistics``
(``core/analysis/FirstOrder``). The definitions follow PyRadiomics [vanGriethuysen2017]_ and the IBSI
[Zwanenburg2020]_, and are checked against PyRadiomics in the core tests. Every value is NaN for an empty region.

``Mean``
   .. math:: \bar{v} = \frac{1}{N} \sum_{t=1}^{N} v_t

   NaN if the region is empty.

``Std``
   Sample standard deviation:

   .. math:: s = \sqrt{\frac{1}{N - 1} \sum_{t=1}^{N} (v_t - \bar{v})^2}

   0 for a single pixel and NaN for an empty region.

``Minimum``, ``Maximum``, ``Range``
   :math:`v_{(1)}`, :math:`v_{(N)}` and :math:`v_{(N)} - v_{(1)}`.

``Median``, ``Percentile10``, ``Percentile90``
   The percentiles :math:`P_{50}`, :math:`P_{10}` and :math:`P_{90}`, interpolated linearly between the sorted values
   (NumPy's default):

   .. math:: P_q = v_{(k)} + (h - k + 1) \, \bigl(v_{(k+1)} - v_{(k)}\bigr), \qquad h = 1 + (N - 1) \frac{q}{100}, \quad k = \lfloor h \rfloor

   with :math:`v_{(N+1)} = v_{(N)}`.

``InterquartileRange``
   .. math:: f = P_{75} - P_{25}

``MeanAbsoluteDeviation``
   .. math:: f = \frac{1}{N} \sum_{t=1}^{N} |v_t - \bar{v}|

``RobustMeanAbsoluteDeviation``
   The mean absolute deviation of the :math:`N_{10-90}` values with :math:`P_{10} \le v_t \le P_{90}` from their own
   mean :math:`\bar{v}_{10-90}`:

   .. math:: f = \frac{1}{N_{10-90}} \sum_{P_{10} \le v_t \le P_{90}} |v_t - \bar{v}_{10-90}|

``RootMeanSquared``
   .. math:: f = \sqrt{\frac{1}{N} \sum_{t=1}^{N} v_t^2}

``FirstOrderEnergy`` — Energy (first-order)
   .. math:: f = \sum_{t=1}^{N} v_t^2

   Without an intensity shift (PyRadiomics' ``voxelArrayShift`` of 0). It grows with the number of pixels, so it only
   compares ROIs of the same size.

``Variance``
   Population variance, unlike ``Std``:

   .. math:: \sigma^2 = \frac{1}{N} \sum_{t=1}^{N} (v_t - \bar{v})^2

``Skewness``
   .. math:: f = \frac{\frac{1}{N} \sum_{t} (v_t - \bar{v})^3}{\sigma^3}

   0 when :math:`\sigma = 0`.

``Kurtosis``
   .. math:: f = \frac{\frac{1}{N} \sum_{t} (v_t - \bar{v})^4}{\sigma^4}

   Not the excess kurtosis: a normal distribution gives 3. 0 when :math:`\sigma = 0`.

``FirstOrderEntropy`` — Entropy (first-order)
   With :math:`p(i) = N_i / N` the fraction of the region's pixels at gray level :math:`i` after quantization:

   .. math:: f = -\sum_{i=0}^{N_g-1} p(i) \log\bigl(p(i) + \epsilon\bigr)

   :math:`\epsilon` is the machine epsilon (:math:`2.2 \cdot 10^{-16}`), and the logarithm follows the log base setting
   (PyRadiomics uses :math:`\log_2`).

``Uniformity``
   .. math:: f = \sum_{i=0}^{N_g-1} p(i)^2

Haralick features
~~~~~~~~~~~~~~~~~

Features F1–F14 of [Haralick1973]_ (see also [Haralick1979]_).

``Energy`` — Angular Second Moment
   .. math:: f = \sum_{i,j} p(i, j)^2

``Contrast``
   .. math:: f = \sum_{n=0}^{N_g-1} n^2 \, p_{x-y}(n)

``ContrastAnotherWay`` — cross-check of ``Contrast``
   .. math:: f = \sum_{i,j} (i - j)^2 \, p(i, j)

``CorrelationII`` — Haralick's correlation
   .. math:: f = \frac{\sum_{i,j} i \, j \, p(i, j) - \mu_x \mu_y}{\sigma_x \sigma_y}

   If :math:`\sigma_x \sigma_y = 0` (for example a constant region), the correlation is undefined and 1 is returned,
   as in PyRadiomics. The same applies to ``CorrelationI``, ``CorrelationIII`` and the "another way" variants (with
   :math:`\sigma_i \sigma_j`).

``CorrelationIIAnotherWay`` — cross-check of ``CorrelationII``
   .. math:: f = \frac{\sum_{i,j} i \, j \, p(i, j) - \mu_i \mu_j}{\sigma_i \sigma_j}

``SumOfSquares`` — variance in :math:`i` and :math:`j`
   .. math:: f = \sum_{i,j} \left[ (i - \mu_i)^2 + (j - \mu_j)^2 \right] p(i, j)

   Haralick's F4 "Sum of Squares: Variance" uses only one of the two terms; see ``SumOfSquaresI``.

``SumOfSquaresI`` — variance in :math:`i`
   .. math:: f = \sum_{i,j} (i - \mu_i)^2 \, p(i, j)

``SumOfSquaresJ`` — variance in :math:`j`
   .. math:: f = \sum_{i,j} (j - \mu_j)^2 \, p(i, j)

``HomogeneityII`` — Inverse Difference Moment
   .. math:: f = \sum_{i,j} \frac{p(i, j)}{1 + (i - j)^2}

``SumAverage``
   .. math:: f_{SA} = \sum_{k=0}^{2N_g-2} k \, p_{x+y}(k)

``SumVariance``
   .. math:: f = \sum_{k=0}^{2N_g-2} \left(k - f_{SA}\right)^2 p_{x+y}(k)

   Centered on the Sum Average. The printed paper [Haralick1973]_ centers it on the Sum Entropy, which is a
   known typo.

``SumEntropy``
   .. math:: f = -\sum_{k=0}^{2N_g-2} p_{x+y}(k) \log p_{x+y}(k)

``Entropy``
   .. math:: f = -\sum_{i,j} p(i, j) \log p(i, j)

``DifferenceVariance``
   .. math::

      \mu_{x-y} = \sum_{k=0}^{N_g-1} k \, p_{x-y}(k), \qquad
      f = \sum_{k=0}^{N_g-1} \left(k - \mu_{x-y}\right)^2 p_{x-y}(k)

``DifferenceEntropy``
   .. math:: f = -\sum_{k=0}^{N_g-1} p_{x-y}(k) \log p_{x-y}(k)

``InformationMeasuresOfCorrelationI`` and ``InformationMeasuresOfCorrelationII``
   With the entropies

   .. math::

      HX  &= -\sum_{i} p_x(i) \log p_x(i), \qquad
      HY   = -\sum_{j} p_y(j) \log p_y(j), \qquad
      HXY  = -\sum_{i,j} p(i, j) \log p(i, j) \\
      HXY1 &= -\sum_{i,j} p(i, j) \log\big(p_x(i) \, p_y(j)\big), \qquad
      HXY2  = -\sum_{i,j} p_x(i) \, p_y(j) \log\big(p_x(i) \, p_y(j)\big)

   where terms with :math:`p_x(i) \, p_y(j) = 0` are skipped,

   .. math::

      f_{IMC1} = \frac{HXY - HXY1}{\max(HX, HY)}, \qquad
      f_{IMC2} = \sqrt{1 - \exp\big(-2 \, (HXY2 - HXY)\big)}

   If :math:`\max(HX, HY) = 0` (a single gray level), :math:`f_{IMC1} = 0`. If rounding makes
   :math:`1 - \exp(-2 \, (HXY2 - HXY))` negative, :math:`f_{IMC2} = 0`. These are the values PyRadiomics uses.

   Requesting either type calculates both.

``MaximalCorrelationCoefficient``
   The slowest feature: it needs an eigen-decomposition of an :math:`N_g \times N_g` matrix for every direction.

   .. math:: Q(i, j) = \sum_{k=0}^{N_g-1} \frac{p(i, k) \, p(j, k)}{p_x(i) \, p_y(k)}

   where terms with :math:`p_x(i) \, p_y(k) = 0` are skipped. With :math:`\lambda_2` the second largest real part of
   the eigenvalues of :math:`Q` (computed with Eigen),

   .. math:: f = \sqrt{\max(\lambda_2, 0)}

   A negative :math:`\lambda_2` can only come from rounding and is treated as 0.

Other co-occurrence features
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

``AutoCorrelation``
   .. math:: f = \sum_{i,j} i \, j \, p(i, j)

``CorrelationI``
   .. math:: f = \sum_{i,j} \frac{(i - \mu_x)(j - \mu_y) \, p(i, j)}{\sigma_x \sigma_y}

   Mathematically equal to ``CorrelationII``.

``CorrelationIAnotherWay`` — cross-check of ``CorrelationI``
   .. math:: f = \sum_{i,j} \frac{(i - \mu_i)(j - \mu_j) \, p(i, j)}{\sigma_i \sigma_j}

``CorrelationIII``
   .. math:: f = \frac{\sum_{i,j} i \, j \, p(i, j) - \mu_x \mu_y}{\sigma_x^2 \, \sigma_y^2}

   The source code attributes this form to a paper by Xiaofeng Yang, probably [Yang2012]_.

``ClusterShade``
   .. math:: f = \sum_{i,j} (i + j - \mu_x - \mu_y)^3 \, p(i, j)

   Commonly cited from [Conners1984]_.

``ClusterProminence``
   .. math:: f = \sum_{i,j} (i + j - \mu_x - \mu_y)^4 \, p(i, j)

   Commonly cited from [Conners1984]_.

``Dissimilarity``
   .. math:: f = \sum_{i,j} |i - j| \, p(i, j)

``HomogeneityI``
   .. math:: f = \sum_{i,j} \frac{p(i, j)}{1 + |i - j|}

``MaximumProbability``
   .. math:: f = \max_{i,j} \, p(i, j)

``InverseDifferenceNormalized``
   .. math:: f = \sum_{i,j} \frac{p(i, j)}{1 + |i - j| / N_g}

   See [Clausi2002]_.

``InverseDifferenceMomentNormalized``
   .. math:: f = \sum_{i,j} \frac{p(i, j)}{1 + (i - j)^2 / N_g^2}

   See [Clausi2002]_.

Auto Correlation, Dissimilarity and Maximum Probability are often cited from [Soh1999]_.

Run length features (GLRLM)
~~~~~~~~~~~~~~~~~~~~~~~~~~~

A **run** is a longest line of consecutive pixels of :math:`\Omega` with the same gray level along one direction: 0°
(along the row), 90° (along the column), 45° or 135° (the diagonals, with the pixel steps of the co-occurrence matrix).
Pixels outside the ROI end a run. For each direction, :math:`R(i, j)` counts the runs of gray level :math:`i` and length
:math:`j`; the features are computed per direction, and the mean and range rows combine the directions as for the
co-occurrence features. Runs do not depend on the distance :math:`d`, so every distance reports the same values.

Unlike the co-occurrence features, gray levels are numbered from 1 here, :math:`i = \text{level} + 1`, as in PyRadiomics
[vanGriethuysen2017]_ and the IBSI [Zwanenburg2020]_: several features divide by :math:`i`. The definitions follow
PyRadiomics' GLRLM and are checked against it in the core tests, with a fixed bin width of 1 (which, like PyRadiomics'
bins, starts at the ROI minimum). ``ComputeRunLengthFeatures`` (``core/analysis/RunLength``) computes them; all values
are NaN for an empty region.

With :math:`N_r = \sum_{i,j} R(i, j)` runs, :math:`N_p` pixels in :math:`\Omega`, :math:`p(i, j) = R(i, j) / N_r`,
:math:`R_g(i) = \sum_j R(i, j)` runs per gray level and :math:`R_r(j) = \sum_i R(i, j)` runs per length:

``GlrlmShortRunEmphasis`` — Short Run Emphasis
   .. math:: f = \frac{1}{N_r} \sum_{i,j} \frac{R(i, j)}{j^2}

``GlrlmLongRunEmphasis`` — Long Run Emphasis
   .. math:: f = \frac{1}{N_r} \sum_{i,j} R(i, j) \, j^2

``GlrlmGrayLevelNonUniformity`` — Gray Level Non-Uniformity (GLRLM)
   .. math:: f = \frac{1}{N_r} \sum_i R_g(i)^2

``GlrlmGrayLevelNonUniformityNormalized`` — Gray Level Non-Uniformity Normalized (GLRLM)
   .. math:: f = \frac{1}{N_r^2} \sum_i R_g(i)^2

``GlrlmRunLengthNonUniformity`` — Run Length Non-Uniformity
   .. math:: f = \frac{1}{N_r} \sum_j R_r(j)^2

``GlrlmRunLengthNonUniformityNormalized`` — Run Length Non-Uniformity Normalized
   .. math:: f = \frac{1}{N_r^2} \sum_j R_r(j)^2

``GlrlmRunPercentage`` — Run Percentage
   .. math:: f = \frac{N_r}{N_p}

``GlrlmGrayLevelVariance`` — Gray Level Variance (GLRLM)
   .. math:: f = \sum_{i,j} p(i, j) \, (i - \mu_i)^2, \qquad \mu_i = \sum_{i,j} p(i, j) \, i

``GlrlmRunVariance`` — Run Variance
   .. math:: f = \sum_{i,j} p(i, j) \, (j - \mu_j)^2, \qquad \mu_j = \sum_{i,j} p(i, j) \, j

``GlrlmRunEntropy`` — Run Entropy
   .. math:: f = -\sum_{i,j} p(i, j) \log\bigl(p(i, j) + \epsilon\bigr)

   :math:`\epsilon` is the machine epsilon, and the logarithm follows the log base setting (PyRadiomics uses
   :math:`\log_2`).

``GlrlmLowGrayLevelRunEmphasis`` — Low Gray Level Run Emphasis
   .. math:: f = \frac{1}{N_r} \sum_{i,j} \frac{R(i, j)}{i^2}

``GlrlmHighGrayLevelRunEmphasis`` — High Gray Level Run Emphasis
   .. math:: f = \frac{1}{N_r} \sum_{i,j} R(i, j) \, i^2

``GlrlmShortRunLowGrayLevelEmphasis`` — Short Run Low Gray Level Emphasis
   .. math:: f = \frac{1}{N_r} \sum_{i,j} \frac{R(i, j)}{i^2 j^2}

``GlrlmShortRunHighGrayLevelEmphasis`` — Short Run High Gray Level Emphasis
   .. math:: f = \frac{1}{N_r} \sum_{i,j} \frac{R(i, j) \, i^2}{j^2}

``GlrlmLongRunLowGrayLevelEmphasis`` — Long Run Low Gray Level Emphasis
   .. math:: f = \frac{1}{N_r} \sum_{i,j} \frac{R(i, j) \, j^2}{i^2}

``GlrlmLongRunHighGrayLevelEmphasis`` — Long Run High Gray Level Emphasis
   .. math:: f = \frac{1}{N_r} \sum_{i,j} R(i, j) \, i^2 j^2

Size zone features (GLSZM)
~~~~~~~~~~~~~~~~~~~~~~~~~~

A **zone** is a connected region of pixels of :math:`\Omega` with the same gray level, where a pixel connects to its
eight neighbours (including the diagonals), as in PyRadiomics' 2D computation. Pixels outside the ROI separate zones.
:math:`Z(i, j)` counts the zones of gray level :math:`i` and size :math:`j` pixels. Zones have no direction and do not
depend on the distance :math:`d`, so the same value is reported for every direction and distance.

As for the run length features, gray levels are numbered from 1 (:math:`i = \text{level} + 1`), and the definitions
follow PyRadiomics' GLSZM [vanGriethuysen2017]_ and the IBSI [Zwanenburg2020]_; they are checked against PyRadiomics in
the core tests with a fixed bin width of 1. ``ComputeSizeZoneFeatures`` (``core/analysis/SizeZone``) computes them; all
values are NaN for an empty region.

With :math:`N_z = \sum_{i,j} Z(i, j)` zones, :math:`N_p` pixels in :math:`\Omega`, :math:`p(i, j) = Z(i, j) / N_z`,
:math:`Z_g(i) = \sum_j Z(i, j)` zones per gray level and :math:`Z_s(j) = \sum_i Z(i, j)` zones per size:

``GlszmSmallAreaEmphasis`` — Small Area Emphasis
   .. math:: f = \frac{1}{N_z} \sum_{i,j} \frac{Z(i, j)}{j^2}

``GlszmLargeAreaEmphasis`` — Large Area Emphasis
   .. math:: f = \frac{1}{N_z} \sum_{i,j} Z(i, j) \, j^2

``GlszmGrayLevelNonUniformity`` — Gray Level Non-Uniformity (GLSZM)
   .. math:: f = \frac{1}{N_z} \sum_i Z_g(i)^2

``GlszmGrayLevelNonUniformityNormalized`` — Gray Level Non-Uniformity Normalized (GLSZM)
   .. math:: f = \frac{1}{N_z^2} \sum_i Z_g(i)^2

``GlszmSizeZoneNonUniformity`` — Size Zone Non-Uniformity
   .. math:: f = \frac{1}{N_z} \sum_j Z_s(j)^2

``GlszmSizeZoneNonUniformityNormalized`` — Size Zone Non-Uniformity Normalized
   .. math:: f = \frac{1}{N_z^2} \sum_j Z_s(j)^2

``GlszmZonePercentage`` — Zone Percentage
   .. math:: f = \frac{N_z}{N_p}

``GlszmGrayLevelVariance`` — Gray Level Variance (GLSZM)
   .. math:: f = \sum_{i,j} p(i, j) \, (i - \mu_i)^2, \qquad \mu_i = \sum_{i,j} p(i, j) \, i

``GlszmZoneVariance`` — Zone Variance
   .. math:: f = \sum_{i,j} p(i, j) \, (j - \mu_j)^2, \qquad \mu_j = \sum_{i,j} p(i, j) \, j

``GlszmZoneEntropy`` — Zone Entropy
   .. math:: f = -\sum_{i,j} p(i, j) \log\bigl(p(i, j) + \epsilon\bigr)

   :math:`\epsilon` is the machine epsilon, and the logarithm follows the log base setting (PyRadiomics uses
   :math:`\log_2`).

``GlszmLowGrayLevelZoneEmphasis`` — Low Gray Level Zone Emphasis
   .. math:: f = \frac{1}{N_z} \sum_{i,j} \frac{Z(i, j)}{i^2}

``GlszmHighGrayLevelZoneEmphasis`` — High Gray Level Zone Emphasis
   .. math:: f = \frac{1}{N_z} \sum_{i,j} Z(i, j) \, i^2

``GlszmSmallAreaLowGrayLevelEmphasis`` — Small Area Low Gray Level Emphasis
   .. math:: f = \frac{1}{N_z} \sum_{i,j} \frac{Z(i, j)}{i^2 j^2}

``GlszmSmallAreaHighGrayLevelEmphasis`` — Small Area High Gray Level Emphasis
   .. math:: f = \frac{1}{N_z} \sum_{i,j} \frac{Z(i, j) \, i^2}{j^2}

``GlszmLargeAreaLowGrayLevelEmphasis`` — Large Area Low Gray Level Emphasis
   .. math:: f = \frac{1}{N_z} \sum_{i,j} \frac{Z(i, j) \, j^2}{i^2}

``GlszmLargeAreaHighGrayLevelEmphasis`` — Large Area High Gray Level Emphasis
   .. math:: f = \frac{1}{N_z} \sum_{i,j} Z(i, j) \, i^2 j^2

Neighbourhood gray tone difference features (NGTDM)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

These compare each pixel of :math:`\Omega` with its **neighbourhood**: the pixels of :math:`\Omega` at a Chebyshev
distance of exactly :math:`d` (a ring of :math:`8d` positions; 8 neighbours for :math:`d = 1`), where :math:`d` is the
distance setting. Gray levels are numbered from 1 (:math:`i = \text{level} + 1`). For a pixel of gray level :math:`i`
whose neighbours have the average gray level :math:`\bar{A}`, the difference is :math:`|i - \bar{A}|`; a pixel without
neighbours in :math:`\Omega` contributes a difference of 0. The features have no direction, so the same value is
reported for every direction; each distance gives its own values.

The definitions follow PyRadiomics' NGTDM [vanGriethuysen2017]_ and are checked against it in the core tests (distances
1 and 2, fixed bin width of 1). They differ from the IBSI [Zwanenburg2020]_ in two ways that follow PyRadiomics: the
neighbourhood is the ring at distance :math:`d` rather than the whole square within it, and pixels without neighbours
still count in :math:`n_i`. ``ComputeGrayToneDifferenceFeatures`` (``core/analysis/GrayToneDifference``) computes them;
all values are NaN for an empty region.

For gray level :math:`i`, :math:`n_i` is its number of pixels and :math:`s_i` the sum of their differences. With
:math:`N_{v,p} = \sum_i n_i` (the pixels of :math:`\Omega`), :math:`p_i = n_i / N_{v,p}`, and :math:`N_{g,p}` the number
of gray levels with :math:`p_i \neq 0`; all sums below run over those gray levels:

``NgtdmCoarseness`` — Coarseness
   .. math:: f = \frac{1}{\sum_i p_i s_i}

   :math:`10^6` if :math:`\sum_i p_i s_i = 0` (a region without any difference).

``NgtdmContrast`` — Contrast (NGTDM)
   .. math:: f = \left(\frac{1}{N_{g,p} (N_{g,p} - 1)} \sum_{i,j} p_i p_j (i - j)^2\right) \left(\frac{1}{N_{v,p}} \sum_i s_i\right)

   0 if :math:`N_{g,p} = 1`.

``NgtdmBusyness`` — Busyness
   .. math:: f = \frac{\sum_i p_i s_i}{\sum_{i,j} |i \, p_i - j \, p_j|}

   0 if the denominator is 0.

``NgtdmComplexity`` — Complexity
   .. math:: f = \frac{1}{N_{v,p}} \sum_{i,j} |i - j| \, \frac{p_i s_i + p_j s_j}{p_i + p_j}

``NgtdmStrength`` — Strength
   .. math:: f = \frac{\sum_{i,j} (p_i + p_j)(i - j)^2}{\sum_i s_i}

   0 if :math:`\sum_i s_i = 0`.

Local binary pattern features (LBP)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Local binary patterns [Ojala2002]_ describe which neighbours of a pixel are at least as bright as the pixel. They use
the **original intensities**, not the gray levels, so the quantization does not affect them. For a pixel with value
:math:`v_c`, :math:`P = 8` samples lie on a circle of radius :math:`R = d` (the distance setting) at the offsets

.. math:: r_k = -R \sin\frac{2\pi k}{P}, \qquad c_k = R \cos\frac{2\pi k}{P}, \qquad k = 0, \dots, P - 1

(rows downward, columns to the right), each rounded to 5 decimals. The value :math:`v_k` of a sample is interpolated
bilinearly between the four pixels around it. Samples may lie outside the ROI: they use the image around it, and
positions outside the image count as 0. A sample is set, :math:`b_k = 1`, when :math:`v_k - v_c \ge 0`.

The pattern is **uniform** when the sequence :math:`b_0, \dots, b_{P-1}` changes at most twice between consecutive
samples; its code is then the number of set samples, :math:`\sum_k b_k` (0 to 8). Non-uniform patterns get the code
:math:`P + 1 = 9`. This is the rotation-invariant uniform LBP of scikit-image (``local_binary_pattern(image, 8, R,
'uniform')``), which PyRadiomics' LBP filter also uses; the core tests compare the features with scikit-image.

With :math:`h_k` the fraction of the ROI's pixels with code :math:`k`:

``LbpUniform0`` … ``LbpUniform8`` — LBP Uniform 0 … LBP Uniform 8
   :math:`h_0, \dots, h_8`: pixels whose samples form a uniform pattern with that many samples at least as bright as the
   pixel. Code 0 marks a pixel brighter than its whole circle (a bright spot), code 8 one at most as bright as its
   circle (a dark spot or a flat area), and the codes between them edges and corners.

``LbpNonUniform`` — LBP Non-Uniform
   :math:`h_9`, the pixels with a non-uniform pattern.

``LbpEntropy`` — LBP Entropy
   .. math:: f = -\sum_{k=0}^{9} h_k \log(h_k + \epsilon)

   :math:`\epsilon` is the machine epsilon, and the logarithm follows the log base setting.

``LbpEnergy`` — LBP Energy
   .. math:: f = \sum_{k=0}^{9} h_k^2

The features have no direction, so the same value is reported for every direction; each distance gives its own radius.
``ComputeLocalBinaryPatternFeatures`` (``core/analysis/LocalBinaryPattern``) computes them; all values are NaN for an
empty region.

Shape features (2D)
~~~~~~~~~~~~~~~~~~~

Shape features describe the size and outline of the ROI's pixels and do not look at the intensities, so neither the
quantization nor the gray levels affect them. They follow PyRadiomics' ``shape2D`` class [vanGriethuysen2017]_, and the
core tests compare them with PyRadiomics on masks with curved edges, holes, several parts and pixels that touch only at
a corner.

**Units.** Positions are the pixel centres multiplied by the pixel spacing: column steps of :math:`s_x` and row steps
of :math:`s_y` millimetres. Lengths are then in mm and surfaces in mm². Without a pixel spacing, :math:`s_x = s_y = 1`
and they are in pixels. The spacing of a measurement is written into the exported results (``# pixelSpacingMm``).

**The mesh.** The outline is a mesh of line segments found with marching squares [Lorensen1987]_: every 2 × 2 square
of neighbouring pixel centres is inspected, and where some of its corners belong to the ROI and others do not, a segment
joins the midpoints of the square's edges that separate them. A square whose opposite corners belong to the ROI gets two
segments, so pixels touching only at a corner are separate parts. The mesh thus runs half a pixel outside the outermost
pixel centres, and cuts off the corners of a pixel staircase. Its segments :math:`(\mathbf a_i, \mathbf b_i)`,
:math:`i = 1, \dots, N_f`, are oriented consistently around the ROI.

With :math:`N_p` the number of pixels, the mesh surface :math:`A` and the perimeter :math:`P`:

``ShapeMeshSurface`` — Mesh Surface
   .. math:: A = \frac{1}{2} \sum_{i=1}^{N_f} \left( a_{i,y}\, b_{i,x} - b_{i,y}\, a_{i,x} \right)

   The signed areas of the triangles between the origin and each segment; those outside the ROI cancel.

``ShapePixelSurface`` — Pixel Surface
   .. math:: A_{pixel} = N_p\, s_x s_y

``ShapePerimeter`` — Perimeter
   .. math:: P = \sum_{i=1}^{N_f} \lVert \mathbf a_i - \mathbf b_i \rVert

   Holes add their outline to the perimeter.

``ShapePerimeterSurfaceRatio`` — Perimeter to Surface Ratio
   .. math:: f = \frac{P}{A}

``ShapeSphericity`` — Sphericity
   .. math:: f = \frac{2 \sqrt{\pi A}}{P}

   The perimeter of a circle with the ROI's surface divided by the ROI's perimeter: 1 for a circle, lower for less
   compact or more ragged outlines. The mesh of a pixelated circle is not a circle, so values stay somewhat below 1.

``ShapeMaximumDiameter`` — Maximum 2D Diameter
   The largest distance between two vertices of the mesh. (The core looks only at the vertices of their convex hull,
   where the largest distance always lies, and gets the same value faster.)

For the remaining features, :math:`\lambda_{major} \ge \lambda_{minor}` are the eigenvalues of the covariance matrix
of the pixel centres' positions (in mm), divided by :math:`N_p`: the variances along the ROI's principal axes. They do
not use the mesh.

``ShapeMajorAxisLength`` — Major Axis Length
   .. math:: f = 4 \sqrt{\lambda_{major}}

``ShapeMinorAxisLength`` — Minor Axis Length
   .. math:: f = 4 \sqrt{\lambda_{minor}}

   For a filled ellipse, the major and minor axis lengths are close to its diameters.

``ShapeElongation`` — Elongation
   .. math:: f = \sqrt{\frac{\lambda_{minor}}{\lambda_{major}}}

   1 for a shape without a preferred direction (a circle, a square), towards 0 for a long thin one.

Eigenvalues between :math:`-10^{-10}` and 0 are rounded to 0, as in PyRadiomics; a more negative one gives NaN.
``ComputeShapeFeatures`` (``core/analysis/Shape``) computes them once per ROI, so every distance and direction reports the
same value; all values are NaN for an empty region.

.. note::

   Surfaces and lengths grow with the ROI, so compare them between ROIs measured with the same pixel spacing.
   Sphericity and elongation have no unit. With non-square pixels, the shape is measured as it is in millimetres.

Score
~~~~~

``glcm::ComputeScore`` (used by ``TextureAnalysis::CalculateScore`` and by the analysis pipeline) computes, for each
direction:

.. math::

   \text{Score} = 1.138 \cdot \text{age} - 1.814 \cdot \text{Mean} + 1.416 \cdot \text{Entropy}
                  + 1.714 \cdot \text{Contrast}

The coefficients are configurable (``glcm::ScoreCoefficients``). The defaults above are those of the original
application, fitted with :math:`N_g = 256`, :math:`d = 1`, the mean of the four directions, rectangle/polygon ROIs on
8-bit images and the age in years.

The analysis pipeline therefore computes the score's inputs with those settings by default (*calibration* profile),
whatever the analysis settings are; 16-bit intensities are first mapped to 0–255 with a fixed range. The *current
settings* profile uses the analysis settings instead and adds a warning that the coefficients may not apply.

Resampling
----------

With the *resampling* setting (``AnalysisSettings::resampling``), ``RunAnalysis`` measures a resampled image instead of the
original (``core/imaging/Resampling``), as PyRadiomics does with ``resampledPixelSpacing`` and its default B-spline
interpolator.

**The grid.** With the image's spacing :math:`s` and the new spacing :math:`s'` along an axis, the ratio is
:math:`r = s' / s`, and an axis of :math:`N` pixels gets :math:`\lceil N / r \rceil` new pixels. New pixel :math:`k`
covers :math:`[k r, (k + 1) r)` in original pixel units, so the grid starts at the image's top left corner (PyRadiomics'
alignment) and the centre of new pixel :math:`k` lies at the continuous index :math:`x_k = (k + \tfrac12) r - \tfrac12`
of the original pixel centres.

**The values.** The image is represented by a cubic B-spline :math:`f(x, y) = \sum_{i,j} c_{ij}\, \beta^3(x - i)\,
\beta^3(y - j)` that passes through every pixel value. The coefficients :math:`c` come from the recursive filter of Unser
[Unser1999]_ with the pole :math:`z = \sqrt 3 - 2` and mirror boundaries, applied along the rows and then along the
columns, exactly as ITK's ``BSplineDecompositionImageFilter`` computes them; :math:`f` is evaluated as ITK's
``BSplineInterpolateImageFunction`` evaluates it. A new pixel whose centre lies more than half a pixel beyond the last
pixel centre gets 0, as in ITK; ROIs never contain such pixels. The core tests compare the values with SimpleITK's
``sitkBSpline`` resampling. The values are then **rounded** to the nearest integer and clamped to the bit depth. (ITK and
PyRadiomics truncate towards zero instead, so a resampled intensity there can be 1 lower.)

**The ROIs.** Each ROI is scaled by :math:`1 / r` along each axis — a rotated ellipse becomes the ellipse the scaling maps
it to — so that a new pixel belongs to the ROI when its centre lies inside the original shape. (PyRadiomics resamples its
label mask with nearest-neighbour interpolation instead, which can differ at the edge.) Pixel counts, the area in mm²
and the shape features then use the new pixels and the new spacing.

Choosing features and gray levels
---------------------------------

- The value of most features depends on :math:`N_g` and on how the image is quantized, see [Clausi2002]_,
  [Soh1999]_, [Brynolfsson2017]_ and [Lofstedt2019]_.
- Standardized feature definitions and reference values are given by the Image Biomarker Standardization
  Initiative [Zwanenburg2020]_ and implemented in PyRadiomics [vanGriethuysen2017]_.
- [HallBeyer2017a]_ and [HallBeyer2017b]_ give practical guidance on interpreting and selecting GLCM features.
- [Walker1995]_ analyses where co-occurrence features get their discriminatory power and how to improve it.