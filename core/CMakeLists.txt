# glcm_core: texture feature library of Texture Workbench, with no UI dependencies. It is used by the web server's Node-API addon and
# can be built on its own or through the top-level CMakeLists.txt.
cmake_minimum_required(VERSION 3.22)

project(glcm_core VERSION 0.1.0 LANGUAGES CXX)

find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs)
find_package(Eigen3 REQUIRED NO_MODULE)
find_package(nlohmann_json 3.11 REQUIRED)
# gzip-compressed NIfTI files (imaging/NiftiReader) and PNG chunk checksums
find_package(ZLIB REQUIRED)

add_library(glcm_core STATIC
        analysis/FirstOrder.cpp
        analysis/GrayToneDifference.cpp
        analysis/LocalBinaryPattern.cpp
        analysis/Shape.cpp
        analysis/RunLength.cpp
        analysis/Score.cpp
        analysis/SizeZone.cpp
        analysis/TextureAnalysis.cpp
        imaging/DicomReader.cpp
        imaging/DisplayRenderer.cpp
        imaging/EdgeDetection.cpp
        imaging/ImageHeader.cpp
        imaging/ImageLoader.cpp
        imaging/NiftiReader.cpp
        imaging/PngEncoder.cpp
        imaging/Quantizer.cpp
        imaging/ValueConversion.cpp
        io/Identifiers.cpp
        io/Json.cpp
        io/ResultsCsv.cpp
        io/RoiImageExport.cpp
        pipeline/AnalysisRunner.cpp
        pipeline/AnalysisSettings.cpp
        pipeline/FeatureMap.cpp
        pipeline/FeatureCatalog.cpp
        roi/Livewire.cpp
        roi/RegionSelection.cpp
        roi/RoiOperations.cpp
        roi/Roi.cpp)

target_include_directories(glcm_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(glcm_core PUBLIC ${OpenCV_LIBS} Eigen3::Eigen PRIVATE nlohmann_json::nlohmann_json ZLIB::ZLIB)
target_compile_features(glcm_core PUBLIC cxx_std_17)
# Position-independent code so the static library can be linked into the Node-API addon (a shared library)
set_target_properties(glcm_core PROPERTIES POSITION_INDEPENDENT_CODE ON)

if (CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(glcm_core PRIVATE -Wall -Wextra)
endif ()

# Unit tests (built only when GoogleTest is installed)
option(GLCM_BUILD_TESTS "Build the glcm_core unit tests" ON)

if (GLCM_BUILD_TESTS)
    find_package(GTest)

    if (GTest_FOUND)
        enable_testing()
        add_executable(glcm-tests
                tests/EdgeDetectionTest.cpp
                tests/FeatureMapTest.cpp
                tests/FirstOrderTest.cpp
                tests/GrayToneDifferenceTest.cpp
                tests/LocalBinaryPatternTest.cpp
                tests/ShapeTest.cpp
                tests/RunLengthTest.cpp
                tests/SizeZoneTest.cpp
                tests/TextureAnalysisTest.cpp
                tests/ImagingTest.cpp
                tests/IoTest.cpp
                tests/MedicalImageTest.cpp
                tests/PipelineTest.cpp
                tests/RegionSelectionTest.cpp
                tests/RoiClassTest.cpp
                tests/RoiOperationsTest.cpp
                tests/RoiTest.cpp
                tests/TextureOptionsTest.cpp)
        target_link_libraries(glcm-tests PRIVATE glcm_core GTest::gtest_main nlohmann_json::nlohmann_json)
        # Reference data and sample images of the repository (FirstOrderTest). The repository root: core/ is also built as its own project, where PROJECT_SOURCE_DIR is core/
        target_compile_definitions(glcm-tests PRIVATE GLCM_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/..")
        # Keep the test binary at the top of the build tree (./build/glcm-tests)
        set_target_properties(glcm-tests PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR})
        include(GoogleTest)
        gtest_discover_tests(glcm-tests DISCOVERY_MODE PRE_TEST)
    endif ()
endif ()
